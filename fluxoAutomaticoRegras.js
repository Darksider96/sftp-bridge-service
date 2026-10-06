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
};

const TIPOS_DESTINO = ['synq', 'dazsoft'];

function campanhasDazsoft(config) {
  const lista = (config?.campanhas || []).map((c) => String(c.campanha_id));
  if (config?.campanha_id) lista.push(String(config.campanha_id));
  return lista;
}

/**
 * Para onde vai o mailing de um cliente automático.
 * @param {{id: string, auto_integracao_id: string|null, auto_campanha_id: string|null}} perfil
 * @param {object|null} integracao linha de client_integrations apontada pelo perfil
 */
function resolverDestino(perfil, integracao) {
  if (!perfil.auto_integracao_id || !integracao) return { ok: false };
  if (integracao.client_id !== perfil.id || !integracao.active) return { ok: false };
  if (!TIPOS_DESTINO.includes(integracao.integration_type)) return { ok: false };

  let campanhaId = null;
  if (integracao.integration_type === 'dazsoft') {
    campanhaId = perfil.auto_campanha_id;
    if (!campanhaId || !campanhasDazsoft(integracao.config).includes(String(campanhaId))) return { ok: false };
  }

  return { ok: true, tipo: integracao.integration_type, integracaoId: integracao.id, campanhaId };
}

// O aviso de aprovação abaixo do mínimo é gravado em erro_mensagem no próprio
// job 'concluido' (checkRetorno.js, publishFinalResult).
function deveSegurarPorAprovacao(jobConcluido) {
  return Boolean(jobConcluido?.erro_mensagem);
}

function contarRegistros(csvText) {
  return parseMailingCsv(csvText).length;
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

module.exports = {
  MOTIVOS,
  resolverDestino,
  deveSegurarPorAprovacao,
  contarRegistros,
  envioTravado,
  nomesParaEnvio,
};
