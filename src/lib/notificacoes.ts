import nodemailer from 'nodemailer';
import { prisma } from './prisma';

const emailConfigurado = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

const transporter = emailConfigurado
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } })
  : null;

/** Envia e-mail sem bloquear a resposta da API. Silencioso quando o e-mail não está configurado. */
export function enviarEmail(para: string | null | undefined, assunto: string, html: string) {
  if (!transporter || !para) return;
  transporter
    .sendMail({ from: `"ViaPro ERP" <${process.env.EMAIL_USER}>`, to: para, subject: assunto, html })
    .catch(err => console.error('Falha ao enviar e-mail:', err?.message));
}

/** Push via Expo para todos os aparelhos registrados (mesma lógica de antes, isolada aqui). */
export async function enviarPush(titulo: string, corpo: string) {
  try {
    const operadores = await prisma.usuario.findMany({ where: { pushToken: { not: null } }, select: { pushToken: true } });
    const tokens = operadores.map(o => o.pushToken).filter(Boolean) as string[];
    if (tokens.length === 0) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: tokens, title: titulo, body: corpo, sound: 'default', priority: 'high' }),
    });
  } catch (err) {
    console.error('Falha ao disparar a notificação para a Expo:', err);
  }
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function htmlPedidoCompra(p: {
  codigo: string | null; quantidade: number; custoTotal: number; dataPrevisao: Date | null;
  produto: { nome: string; sku: string }; fornecedor: { nomeEmpresa: string; contatoNome: string | null };
}) {
  return `
  <div style="font-family:Arial,sans-serif;color:#1f2937;max-width:560px">
    <h2 style="margin:0 0 4px">Pedido de Compra ${p.codigo ?? ''}</h2>
    <p style="margin:0 0 16px;color:#6b7280">Olá ${p.fornecedor.contatoNome || p.fornecedor.nomeEmpresa}, segue nosso pedido:</p>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:6px;border:1px solid #e5e7eb">Produto</td><td style="padding:6px;border:1px solid #e5e7eb"><b>[${p.produto.sku}] ${p.produto.nome}</b></td></tr>
      <tr><td style="padding:6px;border:1px solid #e5e7eb">Quantidade</td><td style="padding:6px;border:1px solid #e5e7eb">${p.quantidade}</td></tr>
      <tr><td style="padding:6px;border:1px solid #e5e7eb">Valor total</td><td style="padding:6px;border:1px solid #e5e7eb">${brl(p.custoTotal)}</td></tr>
      <tr><td style="padding:6px;border:1px solid #e5e7eb">Previsão de entrega</td><td style="padding:6px;border:1px solid #e5e7eb">${p.dataPrevisao ? p.dataPrevisao.toLocaleDateString('pt-BR') : 'A combinar'}</td></tr>
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:16px">Mensagem automática do ViaPro ERP.</p>
  </div>`;
}
