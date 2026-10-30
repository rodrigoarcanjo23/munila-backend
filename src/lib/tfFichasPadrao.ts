// ============================================================
// ✨ FASE 9: fichas do "Registro de transformação de produto: importado / inacabado"
// (planilha REGISTRO DE TRANSFORMAÇÃO DE PRODUTO.xlsx, 8 abas).
//
// Cada ficha lista as saídas possíveis (receitas). A proporção vem da coluna "CÁLCULO":
//   Lenço:      Packs ÷ 3 → displays · Packs ÷ 2 → cx 24 packs · (Packs × 8) ÷ 2 → mini
//   Quadrado:   Sachês ÷ 2 → cartuchos · Sachês ÷ 20 → displays
//   Bichinhos:  (Total ÷ 6) ÷ 4 → caixa com 6 de cada um dos 4 bichos (24 un)
//   Mix:        (Total ÷ 4) ÷ 5 → display com 4 de cada um dos 5 sachês (20 compressas)
//   Puxa Saco:  Refis ÷ 3 → blister com 3 refis
//   Disp. + 2:  sem cálculo na planilha; pelo nome, 1 dispositivo (bag) + 2 refis por unidade
//
// Códigos: a planilha repete códigos entre o importado e o acabado (00833 nos dois lados;
// 836/0836/00836). Para o sistema não confundir, todo importado ganhou o prefixo "IMP-"
// e os acabados ficaram com 5 dígitos. Os dois "00946" viraram 00946 e 00946-DSP.
// ============================================================

export interface MaterialPadrao { codigo: string; nome: string; tipo: 'MATERIA_PRIMA' | 'PRODUTO'; unidade: string }
export interface ReceitaPadrao { codigo: string; nome: string; produto: string; base: number; itens: [string, number][] }
export interface FichaPadrao { codigo: string; nome: string; saidas: string[]; observacao?: string }

const mp = (codigo: string, nome: string, unidade: string): MaterialPadrao => ({ codigo, nome, tipo: 'MATERIA_PRIMA', unidade });
const pa = (codigo: string, nome: string, unidade: string): MaterialPadrao => ({ codigo, nome, tipo: 'PRODUTO', unidade });

export const MATERIAIS_PADRAO: MaterialPadrao[] = [
  // importados / inacabados
  mp('IMP-00833', 'Lenço Umedecido Tá na Mão (caixa com 48 packs) - importado', 'PACK'),
  mp('IMP-332', 'Sachê p/ Passa Febre Quadrado (caixa com 840 sachês)', 'SACHE'),
  mp('IMP-756-1', 'Sachê p/ Passa Febre Individual Bichinhos - Baleia (caixa com 840 sachês)', 'SACHE'),
  mp('IMP-756-2', 'Sachê p/ Passa Febre Individual Bichinhos - Golfinho (caixa com 840 sachês)', 'SACHE'),
  mp('IMP-756-3', 'Sachê p/ Passa Febre Individual Bichinhos - Peixe (caixa com 840 sachês)', 'SACHE'),
  mp('IMP-756-4', 'Sachê p/ Passa Febre Individual Bichinhos - Carro (caixa com 840 sachês)', 'SACHE'),
  mp('IMP-836', 'Refil Saco AZUL para Puxa Saco (caixa com 1.500 refis)', 'UN'),
  mp('IMP-854', 'Refil Saco ROSA para Puxa Saco (caixa com 1.500 refis)', 'UN'),
  mp('IMP-0836', 'Bag plástico AZUL para Puxa Saco - dispositivo (caixa com 500 und)', 'UN'),
  mp('IMP-0854', 'Bag plástico ROSA para Puxa Saco - dispenser (caixa com 500 und)', 'UN'),
  // acabados
  pa('00834', 'Lenço Tá na Mão - cx com 08 DISPLAYS', 'DISPLAY'),
  pa('00833', 'Lenço Tá na Mão - cx com 24 PACKS', 'PACK'),
  pa('00946-DSP', 'Lenço Tá na Mão UNITÁRIO DISPLAY cx c/ 192 mini', 'PACOTE'),
  pa('00946', 'Lenço Tá na Mão UNITÁRIO cx c/ 192 mini', 'PACOTE'),
  pa('00162', 'Passa Febre CARTUCHO com 2 compressas - caixa com 14 cartuchos', 'CARTUCHO'),
  pa('00309', 'Passa Febre DISPLAY com 20 compressas - caixa com 6 Displays', 'DISPLAY'),
  pa('00756', 'Passa Febre Individual BICHINHOS com 1 - caixa com 24 und', 'UN'),
  pa('00836', 'Puxa Saco (3 REFIS AZUL) - caixa com 12 blisters', 'UN'),
  pa('00854', 'Puxa Saco (3 REFIS ROSA) - caixa com 12 blisters', 'UN'),
  pa('00835', 'Puxa Saco - DISPOSITIVO + 2 REFIS AZUL - caixa com 12', 'UN'),
  pa('00853', 'Puxa Saco - DISPENSER + 2 REFIS ROSA - caixa com 12', 'UN'),
];

const BICHOS = ['IMP-756-1', 'IMP-756-2', 'IMP-756-3', 'IMP-756-4'];

/** base = quanto a receita rende; itens = [material, quanto consome para render a base]. */
export const RECEITAS_PADRAO: ReceitaPadrao[] = [
  { codigo: 'RC-00834', nome: 'Display Tá na Mão (Packs ÷ 3)', produto: '00834', base: 1, itens: [['IMP-00833', 3]] },
  { codigo: 'RC-00833', nome: 'Tá na Mão cx 24 packs (Packs ÷ 2)', produto: '00833', base: 1, itens: [['IMP-00833', 2]] },
  { codigo: 'RC-00946-DSP', nome: 'Tá na Mão mini display ((Packs × 8) ÷ 2)', produto: '00946-DSP', base: 4, itens: [['IMP-00833', 1]] },
  { codigo: 'RC-00946', nome: 'Tá na Mão mini ((Packs × 8) ÷ 2)', produto: '00946', base: 4, itens: [['IMP-00833', 1]] },
  { codigo: 'RC-00162', nome: 'Passa Febre cartucho (Sachês ÷ 2)', produto: '00162', base: 1, itens: [['IMP-332', 2]] },
  { codigo: 'RC-00309-QUAD', nome: 'Passa Febre display quadrado (Sachês ÷ 20)', produto: '00309', base: 1, itens: [['IMP-332', 20]] },
  { codigo: 'RC-00756', nome: 'Passa Febre Bichinhos ((Total ÷ 6) ÷ 4)', produto: '00756', base: 1, itens: BICHOS.map(b => [b, 6] as [string, number]) },
  { codigo: 'RC-00309-MIX', nome: 'Passa Febre display mix ((Total ÷ 4) ÷ 5)', produto: '00309', base: 1, itens: [...BICHOS, 'IMP-332'].map(b => [b, 4] as [string, number]) },
  { codigo: 'RC-00836', nome: 'Puxa Saco 3 refis azul (Refis ÷ 3)', produto: '00836', base: 1, itens: [['IMP-836', 3]] },
  { codigo: 'RC-00854', nome: 'Puxa Saco 3 refis rosa (Refis ÷ 3)', produto: '00854', base: 1, itens: [['IMP-854', 3]] },
  { codigo: 'RC-00835', nome: 'Puxa Saco dispositivo + 2 refis azul', produto: '00835', base: 1, itens: [['IMP-0836', 1], ['IMP-836', 2]] },
  { codigo: 'RC-00853', nome: 'Puxa Saco dispenser + 2 refis rosa', produto: '00853', base: 1, itens: [['IMP-0854', 1], ['IMP-854', 2]] },
];

export const FICHAS_PADRAO: FichaPadrao[] = [
  { codigo: 'LENCO-TA-NA-MAO', nome: 'Lenço Tá na Mão', saidas: ['RC-00834', 'RC-00833', 'RC-00946-DSP', 'RC-00946'] },
  { codigo: 'PF-QUADRADO', nome: 'Passa Febre Quadrado', saidas: ['RC-00162', 'RC-00309-QUAD'] },
  { codigo: 'PF-BICHINHOS', nome: 'Passa Febre Individual Bichinhos', saidas: ['RC-00756'] },
  { codigo: 'PF-MIX', nome: 'Passa Febre Mix Bichinhos + Quadrado', saidas: ['RC-00309-MIX'] },
  { codigo: 'PS-3REFIS-AZUL', nome: 'Puxa Saco (3 refis azul)', saidas: ['RC-00836'] },
  { codigo: 'PS-3REFIS-ROSA', nome: 'Puxa Saco (3 refis rosa)', saidas: ['RC-00854'] },
  { codigo: 'PS-DISP-AZUL', nome: 'Puxa Saco - dispositivo + 2 refis azul', saidas: ['RC-00835'] },
  { codigo: 'PS-DISP-ROSA', nome: 'Puxa Saco - dispenser + 2 refis rosa', saidas: ['RC-00853'] },
];
