import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

// 1. LISTAR TODOS OS FORNECEDORES (GET /fornecedores)
router.get('/', async (req, res) => {
  try {
    const fornecedores = await prisma.fornecedor.findMany({
      orderBy: { nomeEmpresa: 'asc' } // Já devolve ordenado alfabeticamente
    });
    return res.json(fornecedores);
  } catch (error) {
    console.error("Erro ao buscar fornecedores:", error);
    return res.status(500).json({ error: 'Erro ao buscar fornecedores.' });
  }
});

// 2. CRIAR NOVO FORNECEDOR (POST /fornecedores)
router.post('/', async (req, res) => {
  try {
    const { nomeEmpresa, cnpj, contatoNome, telefone, email } = req.body;

    if (!nomeEmpresa) {
      return res.status(400).json({ error: 'O Nome da Empresa é obrigatório.' });
    }

    const novoFornecedor = await prisma.fornecedor.create({
      data: { nomeEmpresa, cnpj, contatoNome, telefone, email }
    });

    return res.status(201).json(novoFornecedor);
  } catch (error) {
    console.error("Erro ao cadastrar fornecedor:", error);
    return res.status(500).json({ error: 'Erro ao cadastrar fornecedor.' });
  }
});

// 3. ATUALIZAR FORNECEDOR (PUT /fornecedores/:id)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nomeEmpresa, cnpj, contatoNome, telefone, email } = req.body;

    const fornecedorAtualizado = await prisma.fornecedor.update({
      where: { id },
      data: { nomeEmpresa, cnpj, contatoNome, telefone, email }
    });

    return res.json(fornecedorAtualizado);
  } catch (error) {
    console.error("Erro ao atualizar fornecedor:", error);
    return res.status(500).json({ error: 'Erro ao atualizar os dados do fornecedor.' });
  }
});

// 4. EXCLUIR FORNECEDOR (DELETE /fornecedores/:id)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.fornecedor.delete({
      where: { id }
    });

    return res.status(204).send(); // 204 = No Content (Sucesso, mas não precisa devolver nada)
  } catch (error) {
    console.error("Erro ao excluir fornecedor:", error);
    return res.status(400).json({ error: 'Não foi possível excluir o fornecedor. Pode estar atrelado a algum registo.' });
  }
});

export default router;