Markdown
# 📦 ViaPro ERP - API (Back-end)

> O "Cérebro" do sistema corporativo de Gestão de Armazém, Supply Chain e Inteligência Financeira.

Esta é a API RESTful do sistema ViaPro. Construída em arquitetura monolítica para garantir estabilidade e altíssima performance. Ela é responsável por gerenciar regras de negócios críticas, trilhas de auditoria de segurança (Caixa Preta), disparos de e-mail automatizados e persistência de dados.

## 🚀 Tecnologias Utilizadas

* **Node.js & Express:** Roteamento e criação da API REST.
* **TypeScript:** Tipagem estática para maior segurança e previsibilidade no código.
* **Prisma ORM:** Modelagem de dados e comunicação simplificada com o banco de dados.
* **Nodemailer:** Integração SMTP para disparo automático de e-mails de Pedidos de Compra.
* **Cors:** Gerenciamento de permissões de acesso para o Front-end e Mobile.

## ⚙️ Regras de Negócio Core

* **Prevenção de Duplicidade:** Bloqueio automático de cadastro de produtos com SKU ou Código de Barras já existentes.
* **Movimentação Inteligente:** Lógica avançada que processa Entradas, Saídas, Demonstrações e calcula automaticamente **Perdas e Avarias (Rupturas)**.
* **Supply Chain:** Geração sequencial de códigos para requisições e pedidos (ex: `PC000126`).
* **Caixa Preta (Auditoria):** Qualquer exclusão sensível (produtos ou usuários) exige um motivo e o registro do responsável, criando um log inalterável.

---

## 🛠️ Guia Completo de Instalação e Configuração

Siga os passos abaixo para rodar o Back-end localmente na sua máquina.

### 1. Clonar o Repositório
```bash
git clone [https://github.com/rodrigoarcanjo23/controle-estoque-api.git](https://github.com/rodrigoarcanjo23/controle-estoque-api.git)
cd controle-estoque-api
2. Instalar as Dependências
Certifique-se de ter o Node.js instalado. Rode o comando abaixo para instalar todos os pacotes necessários (Express, Prisma, TypeScript, etc.):

Bash
npm install
3. Configurar as Variáveis de Ambiente (.env)
Crie um arquivo chamado .env na raiz do projeto (na mesma pasta onde está o package.json). Copie a estrutura abaixo e cole dentro do arquivo, substituindo com as suas credenciais:

Snippet de código
# Configuração do Banco de Dados
# Se for SQLite local:
DATABASE_URL="file:./dev.db"
# Se for PostgreSQL na nuvem (ex: Render/Supabase):
# DATABASE_URL="postgresql://usuario:senha@host:5432/viapro?schema=public"

# Porta onde o servidor vai rodar
PORT=3333

# Configuração do Robô de E-mail (Nodemailer)
EMAIL_USER="seu-email-comercial@gmail.com"
EMAIL_PASS="sua-senha-de-aplicativo-google"
4. Sincronizar o Banco de Dados com o Prisma
Com o .env configurado, precisamos criar as tabelas no banco de dados baseadas no nosso schema.prisma. Rode o comando:

Bash
npx prisma db push
Nota: Este comando lê o esquema e cria as tabelas automaticamente. Se você precisar gerar o cliente local do Prisma para o TypeScript reconhecer as tipagens, rode também:

Bash
npx prisma generate
5. Iniciar o Servidor
Com o banco de dados pronto, inicie o servidor em modo de desenvolvimento:

Bash
npm run dev
O terminal exibirá a mensagem: 🚀 Servidor ViaPro rodando na porta 3333.

Desenvolvido com ☕ e código limpo por Bonfirecode.
