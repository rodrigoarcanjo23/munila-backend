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

/** Canal Android usado para avisar de nova ordem de separação (som próprio e pop-up na tela). Precisa ser o mesmo do app. */
export const CANAL_ORDENS = 'ordens-separacao';

interface OpcoesPush {
  /** Dados que o app recebe junto (ex.: { tipo: 'nova-os', ordemId }). */
  data?: Record<string, unknown>;
  /** Usuário que não deve receber (quem criou a ordem). */
  excluirUsuarioId?: string | null;
  /** Canal Android (define som e importância no aparelho). */
  canal?: string;
}

/**
 * Push via Expo para todos os aparelhos registrados.
 * Tokens que a Expo devolve como "DeviceNotRegistered" (app desinstalado ou deslogado) são limpos do cadastro.
 */
export async function enviarPush(titulo: string, corpo: string, opcoes: OpcoesPush = {}) {
  try {
    const usuarios = await prisma.usuario.findMany({
      where: { pushToken: { not: null }, ...(opcoes.excluirUsuarioId ? { id: { not: opcoes.excluirUsuarioId } } : {}) },
      select: { id: true, pushToken: true },
    });
    const destinos = usuarios.filter(u => u.pushToken && /^Expo(nent)?PushToken\[/.test(u.pushToken));
    if (destinos.length === 0) return;

    for (let i = 0; i < destinos.length; i += 100) {
      const lote = destinos.slice(i, i + 100);
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(lote.map(u => ({
          to: u.pushToken, title: titulo, body: corpo, data: opcoes.data ?? {},
          sound: 'default', priority: 'high', channelId: opcoes.canal, ttl: 3600,
        }))),
      });
      const json: any = await resp.json().catch(() => null);
      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];
      const invalidos = lote.filter((_, k) => tickets[k]?.status === 'error' && tickets[k]?.details?.error === 'DeviceNotRegistered').map(u => u.id);
      if (invalidos.length) await prisma.usuario.updateMany({ where: { id: { in: invalidos } }, data: { pushToken: null } });
      const outros = tickets.filter(t => t?.status === 'error' && t?.details?.error !== 'DeviceNotRegistered');
      if (outros.length) console.error('Push com erro na Expo:', outros.map(t => t.message).join(' | '));
    }
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
