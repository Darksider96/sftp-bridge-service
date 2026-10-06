// Regras da central de alertas (sininho do admin), sem I/O
// (.specs/features/central-alertas no repositório principal).

const { MOTIVOS } = require('./fluxoAutomaticoRegras');

// A higienizadora costuma devolver em minutos. Caso real (ME7, 2026-09-24):
// ela moveu o arquivo pra Processado e nunca gerou retorno — o ticket ficou
// "aguardando" em silêncio por horas até alguém notar.
const SEM_RETORNO_APOS_MS = 60 * 60 * 1000;
const STATUS_DE_ENVIO = ['pendente', 'enviado'];

/**
 * Envios mais velhos que o limite sem nenhum job mais novo do mesmo ticket.
 * O retorno cria um job NOVO (não atualiza o 'enviado'), então "tem job mais
 * novo" = o retorno chegou, falhou ou houve reenvio (avaliado por conta própria).
 */
function jobsSemRetorno(jobs, agora = new Date()) {
  const limite = agora.getTime() - SEM_RETORNO_APOS_MS;
  return jobs.filter((job) => {
    if (!STATUS_DE_ENVIO.includes(job.status)) return false;
    const enviadoEm = new Date(job.criado_em).getTime();
    if (enviadoEm >= limite) return false;
    return !jobs.some((outro) => outro.ticket_id === job.ticket_id && new Date(outro.criado_em).getTime() > enviadoEm);
  });
}

function alertaSemRetorno(job, ticket, clientName, pastaRetorno, agora = new Date()) {
  const minutos = Math.round((agora.getTime() - new Date(job.criado_em).getTime()) / 60000);
  return {
    tipo: 'sem_retorno',
    chave: `sem_retorno:${job.id}`,
    ticketId: ticket.id,
    mensagem:
      job.status === 'pendente'
        ? `O envio pra higienizadora começou há ${minutos} min e não foi concluído do nosso lado.`
        : `Enviado à higienizadora há ${minutos} min e nenhum retorno chegou em ${pastaRetorno}. Confira se o arquivo foi pra Processado sem gerar retorno.`,
    detalhes: { clientName, mailingName: ticket.mailing_name },
  };
}

const TIPO_DO_EVENTO = {
  envio_automatico_pausado: 'envio_pausado',
  envio_automatico_falhou: 'envio_falhou',
};

/** Evento do fluxo automático (o mesmo que vai pro webhook) → alerta, ou null se não é problema. */
function alertaDoEventoAutomatico(evento) {
  const tipo = TIPO_DO_EVENTO[evento.event];
  if (!tipo) return null;
  // O retorno com aprovação baixa já gera o próprio alerta, com o percentual.
  if (evento.motivo === MOTIVOS.APROVACAO_BAIXA) return null;

  // Sem ticket (planilha do CRM): identifica pelo cliente e pelo mailing.
  const alvo = evento.ticketId ?? `${evento.clientId}:${evento.mailingName}`;
  return {
    tipo,
    chave: `${tipo}:${alvo}:${evento.motivo}`,
    ticketId: evento.ticketId,
    mensagem: evento.motivo,
    detalhes: { clientName: evento.clientName, mailingName: evento.mailingName },
  };
}

module.exports = { jobsSemRetorno, alertaSemRetorno, alertaDoEventoAutomatico, SEM_RETORNO_APOS_MS };
