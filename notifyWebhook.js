// Mesmo endpoint que supabase/functions/notify-ticket-webhook e
// supabase/functions/_shared/notifyWebhook.ts já usam (Digisac/n8n). Versão
// Node porque este serviço roda fora do Deno das Edge Functions.
//
// Best-effort de propósito: notificação nunca deve derrubar o fluxo de
// confirmação do retorno da higienizadora se o webhook externo estiver fora
// do ar.
const DIGISAC_WEBHOOK_URL = 'https://wvenditore.lynkmartech.com.br/webhook/discador-inteligente-notificacao-digisac';

async function notifyDigisacWebhook(payload) {
  try {
    const response = await fetch(DIGISAC_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('notifyDigisacWebhook: webhook retornou erro', response.status, body);
    }
  } catch (err) {
    console.error('notifyDigisacWebhook: falha ao notificar webhook (best-effort, não bloqueia o fluxo):', err.message);
  }
}

module.exports = { notifyDigisacWebhook };
