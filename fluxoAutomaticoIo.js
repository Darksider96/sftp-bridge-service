// Liga a orquestração do fluxo automático (fluxoAutomatico.js) ao mundo real:
// banco, storage, Edge Functions e webhook. Sem lógica de negócio aqui.

const { supabaseAdmin } = require('./supabaseAdmin');
const { notifyDigisacWebhook } = require('./notifyWebhook');
const { criarFluxoAutomatico } = require('./fluxoAutomatico');
const { registrarAlerta } = require('./alertas');
const { alertaDoEventoAutomatico } = require('./alertasRegras');

const BUCKET = 'mailing-files';
const STATUS_FINAL = 'Importado/higienizado, aguardando ativação';
const TABELAS_CRM = { finaz: 'finaz_mailings', vanguard: 'vanguard_mailings', promosys: 'promosys_mailings' };
const COLUNAS_TICKET =
  'id, client_id, mailing_name, original_file_url, original_file_name, processed_file_url, processed_file_name, auto_status, auto_atualizado_em';
const COLUNAS_PERFIL =
  'id, name, optante_higienizacao, fluxo_automatico, fluxo_automatico_desde, auto_integracao_id, auto_campanha_id';

// As Edge Functions de envio abortam em 140s; um pouco mais que isso aqui.
const TIMEOUT_FUNCAO_MS = 160 * 1000;

function exigir({ data, error }, oQue) {
  if (error) {
    const erro = new Error(`${oQue}: ${error.message}`);
    erro.code = error.code;
    throw erro;
  }
  return data;
}

const db = {
  async ticketsPorStatus(status) {
    return exigir(
      await supabaseAdmin.from('tickets').select(COLUNAS_TICKET).eq('auto_status', status).order('created_at'),
      'buscar tickets automáticos'
    );
  },

  // "Só muda se ainda estiver no estado X": quem conseguir a linha é o único
  // que segue, mesmo com duas varreduras ao mesmo tempo.
  async reservar(ticketId, de, para, campos = {}) {
    const linhas = exigir(
      await supabaseAdmin
        .from('tickets')
        .update({ ...campos, auto_status: para, auto_atualizado_em: new Date().toISOString() })
        .eq('id', ticketId)
        .eq('auto_status', de)
        .select('id'),
      'reservar ticket'
    );
    return linhas.length > 0;
  },

  async marcar(ticketId, campos) {
    exigir(
      await supabaseAdmin
        .from('tickets')
        .update({ ...campos, auto_atualizado_em: new Date().toISOString() })
        .eq('id', ticketId),
      'atualizar ticket'
    );
  },

  async perfil(clientId) {
    return exigir(
      await supabaseAdmin.from('profiles').select(COLUNAS_PERFIL).eq('id', clientId).maybeSingle(),
      'buscar cliente'
    );
  },

  async integracao(id) {
    return exigir(
      await supabaseAdmin
        .from('client_integrations')
        .select('id, client_id, integration_type, active, config')
        .eq('id', id)
        .maybeSingle(),
      'buscar integração'
    );
  },

  async baixarArquivo(path) {
    const blob = exigir(await supabaseAdmin.storage.from(BUCKET).download(path), 'baixar arquivo');
    return Buffer.from(await blob.arrayBuffer()).toString('utf-8');
  },

  async statusFinalId() {
    const status = exigir(
      await supabaseAdmin.from('ticket_statuses').select('id').eq('name', STATUS_FINAL).limit(1).maybeSingle(),
      'buscar status final'
    );
    if (!status) console.warn(`fluxo-automatico: status "${STATUS_FINAL}" não encontrado — o status do ticket não será alterado`);
    return status?.id ?? null;
  },

  async criarJobPendente(ticketId) {
    exigir(await supabaseAdmin.from('centrifuga_jobs').insert({ ticket_id: ticketId, status: 'pendente' }), 'criar job');
  },

  async ultimoJob(ticketId) {
    return exigir(
      await supabaseAdmin
        .from('centrifuga_jobs')
        .select('status, erro_mensagem')
        .eq('ticket_id', ticketId)
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'buscar job'
    );
  },

  async perfisAutomaticos() {
    return exigir(
      await supabaseAdmin.from('profiles').select(COLUNAS_PERFIL).eq('fluxo_automatico', true),
      'buscar clientes automáticos'
    );
  },

  async mailingsDesde(desde, clientIds) {
    const todos = [];
    for (const [tipo, tabela] of Object.entries(TABELAS_CRM)) {
      const linhas = exigir(
        await supabaseAdmin
          .from(tabela)
          .select('id, client_id, file_name, file_url, received_at')
          .in('client_id', clientIds)
          .gte('received_at', desde),
        `buscar mailings ${tipo}`
      );
      todos.push(...linhas.map((m) => ({ ...m, tipo })));
    }
    return todos;
  },

  // Por data (não por lista de ids) pra não estourar o tamanho da URL: o
  // ticket de um mailing nunca é mais antigo que o próprio mailing.
  async chavesComTicket(desde) {
    const linhas = exigir(
      await supabaseAdmin
        .from('tickets')
        .select('origem_mailing_tipo, origem_mailing_id')
        .not('origem_mailing_id', 'is', null)
        .gte('created_at', desde),
      'buscar tickets de mailings'
    );
    return new Set(linhas.map((t) => `${t.origem_mailing_tipo}:${t.origem_mailing_id}`));
  },

  async criarTicketDoMailing(dados) {
    // Mesmo critério de getDefaultStatus() no frontend.
    const statuses = exigir(
      await supabaseAdmin.from('ticket_statuses').select('id, type').order('display_order'),
      'buscar status inicial'
    );
    const inicial = statuses.find((s) => s.type === 'em_fila') || statuses[0];
    if (!inicial) throw new Error('nenhum status de ticket cadastrado');

    const { error } = await supabaseAdmin.from('tickets').insert({ ...dados, status_id: inicial.id });
    if (error?.code === '23505') return false; // outra varredura já criou o ticket deste mailing
    if (error) throw new Error(`criar ticket do mailing: ${error.message}`);
    return true;
  },
};

async function chamarFuncao(nome, corpo) {
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resposta = await fetch(`${process.env.SUPABASE_URL}/functions/v1/${nome}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}`, apikey: chave },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TIMEOUT_FUNCAO_MS),
  });
  return { status: resposta.status, data: await resposta.json().catch(() => null) };
}

// Todo evento do fluxo automático vai pro webhook (n8n) e, se for um problema,
// também pra central de alertas do painel.
async function notificar(evento) {
  await registrarAlerta(alertaDoEventoAutomatico(evento));
  await notifyDigisacWebhook(evento);
}

const fluxo = criarFluxoAutomatico({ db, chamarFuncao, notificar });

// 42703 (Postgres) / PGRST204 (PostgREST): coluna inexistente.
const COLUNA_AUSENTE = ['42703', 'PGRST204'];
let avisouColunasAusentes = false;

/** Uma passada do fluxo automático. Nunca lança. */
async function avancarFluxoAutomatico() {
  try {
    await fluxo.avancar();
  } catch (err) {
    if (COLUNA_AUSENTE.includes(err.code)) {
      // O código pode ser publicado antes de o SQL ser aplicado.
      if (!avisouColunasAusentes) {
        console.warn('fluxo-automatico: colunas ainda não existem no banco (migration do fluxo automático não aplicada) — desativado até lá');
        avisouColunasAusentes = true;
      }
      return;
    }
    console.error('fluxo-automatico: erro na varredura:', err.message);
  }
}

module.exports = { avancarFluxoAutomatico };
