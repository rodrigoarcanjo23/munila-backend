import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando o plantio de dados Munila & VIAPRO...');

  const categoria = await prisma.categoria.create({
    data: { nome: 'Catálogo Geral', descricao: 'Produtos e insumos' }
  });

  const usuario = await prisma.usuario.create({
    data: { nome: 'Rodrigo Arcanjo', cargo: 'Representante', email: 'rodrigo@munila.com.br', senha: '123' }
  });

  const localizacaoMunila = await prisma.localizacao.create({
    data: { codigo: 'MUN-01', zona: 'Armazém Munila', corredor: 'A', prateleira: '01' }
  });

  const localizacaoViapro = await prisma.localizacao.create({
    data: { codigo: 'VIA-01', zona: 'Indústria VIAPRO', corredor: 'MP', prateleira: '01' }
  });

  const produtosMunila = [
    { nome: "Lenço Umedecido - Tá na mão!", tipo: "ACABADO" },
    { nome: "Puxa Saco 3 Refis - Azul", tipo: "ACABADO" },
    { nome: "Puxa Saco 3 Refis - Rosa", tipo: "ACABADO" },
    { nome: "Seringa Lavagem Nasal 10ml - Blue", tipo: "ACABADO" },
    { nome: "Suga Suga", tipo: "ACABADO" },
    { nome: "Passa Febre - Bichinhos", tipo: "ACABADO" },
    { nome: "Esponja Meu Banho - Leão", tipo: "ACABADO" },
    { nome: "Touca de Cetim - Vermelho", tipo: "ACABADO" },
    // Matérias Primas da Indústria
    { nome: "Rolo de Tecido Cetim Premium", tipo: "MATERIA_PRIMA" },
    { nome: "Fardo de Plástico Injetável (Seringas)", tipo: "MATERIA_PRIMA" },
    { nome: "Essência Lavanda (Lenços)", tipo: "MATERIA_PRIMA" }
  ];

  for (let i = 0; i < produtosMunila.length; i++) {
    const p = produtosMunila[i];
    const sku = `${p.tipo === 'MATERIA_PRIMA' ? 'MP' : 'MUN'}-${String(i + 1).padStart(3, '0')}`; 

    const produtoCriado = await prisma.produto.create({
      data: {
        sku,
        nome: p.nome,
        tipo: p.tipo,
        categoriaId: categoria.id
      }
    });

    // Coloca 50 unidades de Materia prima na VIAPRO e 8 unidades (crítico) para os acabados
    const quantidadeInicial = p.tipo === 'MATERIA_PRIMA' ? 50 : 8;

    await prisma.estoque.create({
      data: {
        produtoId: produtoCriado.id,
        quantidade: quantidadeInicial,
        status: 'Disponível',
        localizacaoId: p.tipo === 'MATERIA_PRIMA' ? localizacaoViapro.id : localizacaoMunila.id
      }
    });
    console.log(`✅ Cadastrado: ${p.nome} (${p.tipo})`);
  }

  console.log('🚀 Finalizado! O catálogo está no banco de dados!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });