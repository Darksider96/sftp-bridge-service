// Decisões do fluxo automático de mailings, sem I/O
// (.specs/features/fluxo-automatico no repositório principal).

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

module.exports = { MOTIVOS, resolverDestino };
