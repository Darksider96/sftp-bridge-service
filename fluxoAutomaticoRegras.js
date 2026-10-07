// Decisões do fluxo automático de mailings, sem I/O
// (.specs/features/fluxo-automatico no repositório principal).

const { parseMailingCsv } = require('./mailingNormalizer');

// Textos mostrados ao admin e enviados no webhook — definidos na spec.
const MOTIVOS = {
  APROVACAO_BAIXA: 'Envio automático pausado: aprovação baixa',
  DESTINO: 'Envio automático pausado: destino não configurado',
  SEM_REGISTROS: 'Envio automático pausado: arquivo sem registros',
  FALHA: 'Falha no envio automático',
  RETORNO_MAIOR: 'Retorno maior chegou após o envio — revisar',
  PLANILHA: 'Mailing do CRM em planilha: crie o ticket manualmente',
  REPETIDO: 'Envio automático pausado: mailing repetido (mesmo nome e mesma quantidade de contatos)',
};

// Só a Synq: a Dazsoft saiu do automático por definição do Henrique
// (Venditore, 2026-10-07), como a Argus já tinha saído.
const TIPO_DESTINO = 'synq';

/**
 * Para onde vai o mailing de um cliente automático.
 * @param {{id: string, auto_integracao_id: string|null}} perfil
 * @param {object|null} integracao linha de client_integrations apontada pelo perfil
 */
function resolverDestino(perfil, integracao) {
  if (!perfil.auto_integracao_id || !integracao) return { ok: false };
  if (integracao.client_id !== perfil.id || !integracao.active) return { ok: false };
  if (integracao.integration_type !== TIPO_DESTINO) return { ok: false };

  return { ok: true, tipo: TIPO_DESTINO, integracaoId: integracao.id };
}

// Há clientes que clicam em enviar o mesmo mailing várias vezes. Regra do
// Henrique (2026-10-07): mesmo nome e mesma quantidade de contatos = o mesmo
// mailing, e só um é enviado. A janela de 24h é premissa nossa.
const JANELA_REPETIDO_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{id: string, created_at: string}} atual
 * @param {{id: string, created_at: string}[]} iguais tickets do mesmo cliente com o mesmo nome e a mesma quantidade
 */
function ehRepetido(atual, iguais) {
  const criadoEm = new Date(atual.created_at).getTime();
  return iguais.some((outro) => {
    if (outro.id === atual.id) return false;
    const outroEm = new Date(outro.created_at).getTime();
    if (criadoEm - outroEm > JANELA_REPETIDO_MS) return false;
    return outroEm < criadoEm || (outroEm === criadoEm && outro.id < atual.id);
  });
}

// O aviso de aprovação abaixo do mínimo é gravado em erro_mensagem no próprio
// job 'concluido' (checkRetorno.js, publishFinalResult).
function deveSegurarPorAprovacao(jobConcluido) {
  return Boolean(jobConcluido?.erro_mensagem);
}

function contarRegistros(csvText) {
  return parseMailingCsv(csvText).length;
}

// Definição do Henrique (Venditore, 2026-10-07): três tentativas antes de avisar.
const MAX_TENTATIVAS_ENVIO = 3;
const INTERVALO_TENTATIVAS_MS = 30 * 1000;

// Códigos que as funções de envio devolvem quando o destino não chegou a
// responder (tempo esgotado, conexão caiu no meio, gateway). O mailing pode
// ter sido importado, então repetir arriscaria importar em dobro.
const STATUS_SEM_RESPOSTA = [408, 502, 504];

/** Só repete quando há uma resposta de erro: aí o destino recusou o arquivo. */
function podeRepetirEnvio(resposta) {
  if (!resposta?.data) return false;
  return !STATUS_SEM_RESPOSTA.includes(resposta.data.status);
}

const LIMITE_ENVIANDO_MS = 10 * 60 * 1000;

// Um envio leva no máximo ~140s (timeout das Edge Functions). Parado em
// 'enviando' além disso = o serviço caiu no meio; não dá pra saber se o
// destino recebeu, então nunca é reenviado sozinho.
function envioTravado(autoAtualizadoEm, agora = new Date()) {
  return agora.getTime() - new Date(autoAtualizadoEm).getTime() > LIMITE_ENVIANDO_MS;
}

// Mesmas regras de src/pages/admin/AdminTickets.tsx (normalizeForIntegration,
// stripFileExtension) — o envio automático tem que nomear igual ao manual.
function normalizarParaIntegracao(nome) {
  return nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
}

function semExtensao(nomeArquivo) {
  const ponto = nomeArquivo.lastIndexOf('.');
  return ponto === -1 ? nomeArquivo : nomeArquivo.slice(0, ponto);
}

function nomesParaEnvio(ticket, usarProcessado) {
  const arquivo = usarProcessado ? ticket.processed_file_name : ticket.original_file_name;
  const ponto = arquivo.lastIndexOf('.');
  const extensao = ponto === -1 ? '' : arquivo.slice(ponto);
  return {
    fileName: normalizarParaIntegracao(semExtensao(arquivo)) + extensao,
    mailingName: normalizarParaIntegracao(usarProcessado ? semExtensao(arquivo) : ticket.mailing_name),
  };
}

function ehPlanilha(fileName) {
  return /\.(xlsx|xls)$/i.test(fileName);
}

function nomeTicketDoMailing(fileName) {
  return semExtensao(fileName);
}

/**
 * Quais mailings do CRM devem virar ticket automático agora.
 * @param {{tipo: string, id: string, client_id: string, file_name: string, received_at: string}[]} mailings
 * @param {{id: string, fluxo_automatico: boolean, fluxo_automatico_desde: string|null}[]} perfis
 * @param {Set<string>} chavesComTicket "tipo:id" dos mailings que já têm ticket
 */
function mailingsParaTicket(mailings, perfis, chavesComTicket) {
  const perfilPorId = new Map(perfis.map((p) => [p.id, p]));
  const criar = [];
  const planilhas = [];

  for (const m of mailings) {
    const perfil = perfilPorId.get(m.client_id);
    if (!perfil?.fluxo_automatico || !perfil.fluxo_automatico_desde) continue;
    // Ligar o automático não dispara os mailings que já estavam parados lá.
    if (new Date(m.received_at) < new Date(perfil.fluxo_automatico_desde)) continue;
    if (chavesComTicket.has(`${m.tipo}:${m.id}`)) continue;
    (ehPlanilha(m.file_name) ? planilhas : criar).push(m);
  }

  return { criar, planilhas };
}

/**
 * O que muda no estado automático quando um retorno maior reabre o ticket
 * (checkRetorno.js, branch 'reprocess'). null = nada a fazer.
 */
function aoReprocessar(ticket) {
  if (!ticket.fluxo_automatico) return null;

  // O destino já recebeu (ou está recebendo) a lista menor: reenviar sozinho
  // poderia duplicar. Alguém precisa olhar.
  if (ticket.auto_status === 'enviando' || ticket.auto_status === 'enviado') {
    return { campos: { auto_status: 'pausado', auto_motivo: MOTIVOS.RETORNO_MAIOR }, avisar: true };
  }

  // A pausa foi justamente por suspeita de retorno incompleto; o retorno
  // completo chegou, então volta pra fila e é avaliado de novo.
  if (ticket.auto_status === 'pausado' && ticket.auto_motivo === MOTIVOS.APROVACAO_BAIXA) {
    return { campos: { auto_status: 'higienizando', auto_motivo: null }, avisar: false };
  }

  return null;
}

module.exports = {
  aoReprocessar,
  MOTIVOS,
  resolverDestino,
  ehRepetido,
  JANELA_REPETIDO_MS,
  deveSegurarPorAprovacao,
  contarRegistros,
  envioTravado,
  podeRepetirEnvio,
  MAX_TENTATIVAS_ENVIO,
  INTERVALO_TENTATIVAS_MS,
  nomesParaEnvio,
  ehPlanilha,
  nomeTicketDoMailing,
  mailingsParaTicket,
};
