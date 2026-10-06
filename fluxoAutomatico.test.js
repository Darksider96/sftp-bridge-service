const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarFluxoAutomatico } = require('./fluxoAutomatico');
const { MOTIVOS } = require('./fluxoAutomaticoRegras');

const AGORA = new Date('2026-10-06T12:00:00.000Z');
const STATUS_FINAL = 'status-importado';
const CSV_2_REGISTROS = 'ID;NOME;TELEFONE\n1;Ana;11987654321\n2;Bia;21987654321\n';

const ticketBase = (extra = {}) => ({
  id: 't1',
  client_id: 'c1',
  mailing_name: 'Base Outubro',
  original_file_url: 'c1/original/base.csv',
  original_file_name: 'base.csv',
  processed_file_url: 'c1/processed/base.csv',
  processed_file_name: 'Base Outubro_HIG_MODERADA.csv',
  auto_status: 'enviando',
  auto_atualizado_em: AGORA.toISOString(),
  ...extra,
});

const perfilBase = (extra = {}) => ({
  id: 'c1',
  name: 'Cliente Um',
  optante_higienizacao: true,
  fluxo_automatico: true,
  fluxo_automatico_desde: '2026-10-01T00:00:00.000Z',
  auto_integracao_id: 'int-synq',
  auto_campanha_id: null,
  ...extra,
});

const integracaoSynq = { id: 'int-synq', client_id: 'c1', integration_type: 'synq', active: true, config: {} };
const integracaoDazsoft = {
  id: 'int-daz',
  client_id: 'c1',
  integration_type: 'dazsoft',
  active: true,
  config: { campanhas: [{ nome: 'Vendas', campanha_id: '77' }] },
};

// Banco, rede e webhook em memória: o fluxo real roda inteiro, só o I/O é trocado.
function montar({
  tickets = [],
  perfis = [perfilBase()],
  integracoes = [integracaoSynq],
  arquivos = {},
  jobs = {},
  respostas = {},
  reservaNegada = false, // outro processo reservou antes
  erroNoPerfilDe = null,
  mailings = [],
  chavesComTicket = [],
  conflitoAoCriarTicket = false, // outra varredura criou o ticket do mesmo mailing antes
} = {}) {
  const estado = { tickets: tickets.map((t) => ({ ...t })), chamadas: [], eventos: [], jobsCriados: [], ticketsCriados: [] };
  const achar = (id) => estado.tickets.find((t) => t.id === id);

  const db = {
    ticketsPorStatus: async (status) => estado.tickets.filter((t) => t.auto_status === status).map((t) => ({ ...t })),
    reservar: async (id, de, para, campos = {}) => {
      const t = achar(id);
      if (reservaNegada || !t || t.auto_status !== de) return false;
      Object.assign(t, campos, { auto_status: para, auto_atualizado_em: AGORA.toISOString() });
      return true;
    },
    marcar: async (id, campos) => {
      Object.assign(achar(id), campos, { auto_atualizado_em: AGORA.toISOString() });
    },
    perfil: async (clientId) => {
      if (clientId === erroNoPerfilDe) throw new Error('banco indisponível');
      return perfis.find((p) => p.id === clientId) || null;
    },
    integracao: async (id) => integracoes.find((i) => i.id === id) || null,
    baixarArquivo: async (path) => {
      if (!(path in arquivos)) throw new Error(`arquivo não encontrado: ${path}`);
      return arquivos[path];
    },
    statusFinalId: async () => STATUS_FINAL,
    criarJobPendente: async (ticketId) => {
      estado.jobsCriados.push(ticketId);
    },
    ultimoJob: async (ticketId) => jobs[ticketId] || null,
    perfisAutomaticos: async () => perfis.filter((p) => p.fluxo_automatico),
    mailingsDesde: async () => mailings,
    chavesComTicket: async () => new Set(chavesComTicket),
    criarTicketDoMailing: async (dados) => {
      if (conflitoAoCriarTicket) return false;
      estado.ticketsCriados.push(dados);
      return true;
    },
  };

  const chamarFuncao = async (nome, corpo) => {
    estado.chamadas.push({ nome, corpo });
    const resposta = respostas[nome];
    if (resposta instanceof Error) throw resposta;
    return resposta || { status: 200, data: { success: true, status: 200, message: 'OK' } };
  };

  const fluxo = criarFluxoAutomatico({
    db,
    chamarFuncao,
    notificar: async (payload) => {
      estado.eventos.push(payload);
    },
    agora: () => AGORA,
  });

  return { fluxo, estado, ticket: (id = 't1') => achar(id) };
}

const uploads = (estado) => estado.chamadas.filter((c) => c.nome.startsWith('higienizadora-upload-'));

// ---------------------------------------------------------------------------
// enviarAoDestino
// ---------------------------------------------------------------------------

test('AUTO-12: destino respondeu 2xx → ticket enviado, status final, integração e data gravados', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.equal(ticket().auto_status, 'enviado');
  assert.equal(ticket().status_id, STATUS_FINAL);
  assert.equal(ticket().auto_integracao, 'synq');
  assert.equal(ticket().auto_enviado_em, AGORA.toISOString());
  assert.equal(ticket().auto_motivo, null);
  assert.equal(estado.eventos.length, 1);
});

test('AUTO-12: evento envio_automatico_concluido leva ticket, cliente, mailing, integração e quantidade de registros', async () => {
  const { fluxo, estado } = montar({
    tickets: [ticketBase()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.deepEqual(estado.eventos[0], {
    event: 'envio_automatico_concluido',
    ticketId: 't1',
    clientId: 'c1',
    clientName: 'Cliente Um',
    mailingName: 'Base Outubro',
    integracao: 'synq',
    registros: 2,
    motivo: null,
  });
});

test('AUTO-11: o arquivo higienizado vai para a Synq do cliente com o nome do envio manual', async () => {
  const { fluxo, estado } = montar({
    tickets: [ticketBase()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.deepEqual(uploads(estado), [
    {
      nome: 'higienizadora-upload-synq',
      corpo: {
        ticketId: 't1',
        clientId: 'c1',
        fileUrl: 'c1/processed/base.csv',
        fileName: 'Base_Outubro_HIG_MODERADA.csv',
        mailing_name: 'Base_Outubro_HIG_MODERADA',
      },
    },
  ]);
});

test('AUTO-11: destino Dazsoft recebe a campanha configurada no cliente', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase()],
    integracoes: [integracaoDazsoft],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
  });
  const perfil = perfilBase({ auto_integracao_id: 'int-daz', auto_campanha_id: '77' });

  await fluxo.enviarAoDestino(ticketBase(), perfil, true);

  assert.equal(uploads(estado).length, 1);
  assert.equal(uploads(estado)[0].nome, 'higienizadora-upload-dazsoft');
  assert.equal(uploads(estado)[0].corpo.campanha_id, '77');
  assert.equal(ticket().auto_integracao, 'dazsoft');
});

test('AUTO-20: destino inválido → nada é enviado, ticket pausado com o motivo exato e evento de pausa', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase()],
    integracoes: [{ ...integracaoSynq, active: false }],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.equal(uploads(estado).length, 0);
  assert.equal(ticket().auto_status, 'pausado');
  assert.equal(ticket().auto_motivo, 'Envio automático pausado: destino não configurado');
  assert.equal(estado.eventos.length, 1);
  assert.equal(estado.eventos[0].event, 'envio_automatico_pausado');
  assert.equal(estado.eventos[0].motivo, 'Envio automático pausado: destino não configurado');
});

test('AUTO-21: arquivo sem registros → nada é enviado, ticket pausado com o motivo exato e evento de pausa', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase()],
    arquivos: { 'c1/processed/base.csv': 'ID;NOME;TELEFONE\n' },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.equal(uploads(estado).length, 0);
  assert.equal(ticket().auto_status, 'pausado');
  assert.equal(ticket().auto_motivo, 'Envio automático pausado: arquivo sem registros');
  assert.equal(estado.eventos[0].event, 'envio_automatico_pausado');
  assert.equal(estado.eventos[0].motivo, 'Envio automático pausado: arquivo sem registros');
});

test('AUTO-22: destino respondeu erro → falha com a mensagem, evento de falha e nenhuma nova tentativa', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
    respostas: {
      'higienizadora-upload-synq': { status: 200, data: { success: false, status: 403, message: 'Acesso negado' } },
    },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.equal(uploads(estado).length, 1);
  assert.equal(ticket().auto_status, 'falha');
  assert.equal(ticket().auto_motivo, 'Falha no envio automático: Acesso negado');
  assert.equal(ticket().status_id, undefined);
  assert.equal(estado.eventos.length, 1);
  assert.equal(estado.eventos[0].event, 'envio_automatico_falhou');
  assert.equal(estado.eventos[0].motivo, 'Falha no envio automático: Acesso negado');
  assert.equal(estado.eventos[0].integracao, 'synq');
});

test('AUTO-22: falha de conexão com o destino → falha, sem nova tentativa', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
    respostas: { 'higienizadora-upload-synq': new Error('fetch failed') },
  });

  await fluxo.enviarAoDestino(ticketBase(), perfilBase(), true);

  assert.equal(uploads(estado).length, 1);
  assert.equal(ticket().auto_status, 'falha');
  assert.equal(ticket().auto_motivo, 'Falha no envio automático: fetch failed');
  assert.equal(estado.eventos[0].event, 'envio_automatico_falhou');
});

test('AUTO-14: arquivo original passa pela normalização de cabeçalho antes de ir para o destino', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase({ processed_file_url: null, processed_file_name: null })],
    arquivos: { 'c1/original/com-cabecalho-base.csv': CSV_2_REGISTROS },
    respostas: {
      'higienizadora-ensure-mailing-header': {
        status: 200,
        data: { success: true, changed: true, fileUrl: 'c1/original/com-cabecalho-base.csv', fileName: 'base.csv' },
      },
    },
  });

  await fluxo.enviarAoDestino(ticketBase({ processed_file_url: null, processed_file_name: null }), perfilBase(), false);

  assert.deepEqual(estado.chamadas.map((c) => c.nome), ['higienizadora-ensure-mailing-header', 'higienizadora-upload-synq']);
  assert.deepEqual(estado.chamadas[0].corpo, { fileUrl: 'c1/original/base.csv', fileName: 'base.csv' });
  assert.equal(estado.chamadas[1].corpo.fileUrl, 'c1/original/com-cabecalho-base.csv');
  assert.equal(estado.chamadas[1].corpo.mailing_name, 'Base_Outubro');
  assert.equal(ticket().auto_status, 'enviado');
});

// ---------------------------------------------------------------------------
// avancar: iniciar, enviar, recuperar
// ---------------------------------------------------------------------------

const processador = (estado) => estado.chamadas.filter((c) => c.nome === 'processador-centrifuga');
const pendente = (extra = {}) =>
  ticketBase({ auto_status: 'pendente', processed_file_url: null, processed_file_name: null, ...extra });
const higienizando = (extra = {}) => ticketBase({ auto_status: 'higienizando', ...extra });

test('AUTO-10: ticket automático de cliente optante vai para a higienizadora sem ação de admin', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [pendente()],
    respostas: { 'processador-centrifuga': { status: 200, data: { success: true } } },
  });

  await fluxo.avancar();

  assert.deepEqual(estado.jobsCriados, ['t1']);
  assert.deepEqual(processador(estado).map((c) => c.corpo), [{ ticketId: 't1' }]);
  assert.equal(ticket().auto_status, 'higienizando');
  assert.equal(uploads(estado).length, 0);
});

test('AUTO-14: ticket automático de cliente não optante pula a higienizadora e envia o original', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [pendente()],
    perfis: [perfilBase({ optante_higienizacao: false })],
    arquivos: { 'c1/original/base.csv': CSV_2_REGISTROS },
    respostas: {
      'higienizadora-ensure-mailing-header': {
        status: 200,
        data: { success: true, changed: false, fileUrl: 'c1/original/base.csv', fileName: 'base.csv' },
      },
    },
  });

  await fluxo.avancar();

  assert.equal(processador(estado).length, 0);
  assert.deepEqual(estado.jobsCriados, []);
  assert.equal(uploads(estado).length, 1);
  assert.equal(uploads(estado)[0].corpo.fileUrl, 'c1/original/base.csv');
  assert.equal(ticket().auto_status, 'enviado');
});

test('AUTO-22: falha ao enviar para a higienizadora vira falha com o erro e evento, sem nova tentativa', async () => {
  const erro = 'Nenhuma coluna de telefone/DDD encontrada no arquivo';
  const { fluxo, estado, ticket } = montar({
    tickets: [pendente()],
    respostas: { 'processador-centrifuga': { status: 400, data: { success: false, error: erro } } },
  });

  await fluxo.avancar();

  assert.equal(processador(estado).length, 1);
  assert.equal(ticket().auto_status, 'falha');
  assert.equal(ticket().auto_motivo, `Falha no envio automático: ${erro}`);
  assert.equal(estado.eventos.length, 1);
  assert.equal(estado.eventos[0].event, 'envio_automatico_falhou');
  assert.equal(estado.eventos[0].motivo, `Falha no envio automático: ${erro}`);
});

test('AUTO-11: retorno finalizado sem aviso faz o arquivo higienizado ser enviado ao destino', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [higienizando()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
    jobs: { t1: { status: 'concluido', erro_mensagem: null } },
  });

  await fluxo.avancar();

  assert.equal(uploads(estado).length, 1);
  assert.equal(uploads(estado)[0].corpo.fileUrl, 'c1/processed/base.csv');
  assert.equal(ticket().auto_status, 'enviado');
});

test('AUTO-19: retorno com aviso de aprovação baixa não é enviado, pausa com o motivo exato e avisa', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [higienizando()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
    jobs: { t1: { status: 'concluido', erro_mensagem: 'Percentual de aprovação baixo (2644/30000 = 8.8%)' } },
  });

  await fluxo.avancar();

  assert.equal(uploads(estado).length, 0);
  assert.equal(ticket().auto_status, 'pausado');
  assert.equal(ticket().auto_motivo, 'Envio automático pausado: aprovação baixa');
  assert.equal(estado.eventos.length, 1);
  assert.equal(estado.eventos[0].event, 'envio_automatico_pausado');
  assert.equal(estado.eventos[0].motivo, 'Envio automático pausado: aprovação baixa');
});

test('AUTO-11: enquanto o retorno não chegou, nada é enviado', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [higienizando({ processed_file_url: null, processed_file_name: null })],
    jobs: { t1: { status: 'enviado', erro_mensagem: null } },
  });

  await fluxo.avancar();

  assert.equal(uploads(estado).length, 0);
  assert.equal(ticket().auto_status, 'higienizando');
});

test('AUTO-11: retorno ainda em confirmação (job não concluído) não é enviado', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [higienizando()],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
    jobs: { t1: { status: 'retorno_recebido', erro_mensagem: null } },
  });

  await fluxo.avancar();

  assert.equal(uploads(estado).length, 0);
  assert.equal(ticket().auto_status, 'higienizando');
});

test('AUTO-24: se outro processo já reservou o ticket, nada é enviado de novo', async () => {
  const { fluxo, estado } = montar({
    tickets: [higienizando(), pendente({ id: 't2' })],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
    jobs: { t1: { status: 'concluido', erro_mensagem: null } },
    reservaNegada: true,
  });

  await fluxo.avancar();

  assert.equal(uploads(estado).length, 0);
  assert.equal(processador(estado).length, 0);
  assert.deepEqual(estado.jobsCriados, []);
  assert.equal(estado.eventos.length, 0);
});

test('AUTO-24: envio travado em "enviando" há mais de 10 min vira falha com aviso, sem reenviar', async () => {
  const onzeMinAtras = new Date(AGORA.getTime() - 11 * 60 * 1000).toISOString();
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase({ auto_status: 'enviando', auto_atualizado_em: onzeMinAtras })],
    arquivos: { 'c1/processed/base.csv': CSV_2_REGISTROS },
  });

  await fluxo.avancar();

  assert.equal(uploads(estado).length, 0);
  assert.equal(ticket().auto_status, 'falha');
  assert.equal(
    ticket().auto_motivo,
    'Falha no envio automático: envio interrompido — confirme no destino antes de reenviar'
  );
  assert.equal(estado.eventos.length, 1);
  assert.equal(estado.eventos[0].event, 'envio_automatico_falhou');
});

test('AUTO-24: envio em andamento há pouco tempo não é tocado', async () => {
  const umMinAtras = new Date(AGORA.getTime() - 60 * 1000).toISOString();
  const { fluxo, estado, ticket } = montar({
    tickets: [ticketBase({ auto_status: 'enviando', auto_atualizado_em: umMinAtras })],
  });

  await fluxo.avancar();

  assert.equal(ticket().auto_status, 'enviando');
  assert.equal(estado.eventos.length, 0);
  assert.equal(estado.chamadas.length, 0);
});

test('edge case: erro em um ticket não impede os demais de avançar', async () => {
  const { fluxo, estado, ticket } = montar({
    tickets: [pendente({ id: 't-erro', client_id: 'c-erro' }), pendente({ id: 't1' })],
    erroNoPerfilDe: 'c-erro',
    respostas: { 'processador-centrifuga': { status: 200, data: { success: true } } },
  });

  await fluxo.avancar();

  assert.equal(ticket('t1').auto_status, 'higienizando');
  assert.deepEqual(estado.jobsCriados, ['t1']);
});

// ---------------------------------------------------------------------------
// avancar: tickets a partir de mailings do CRM
// ---------------------------------------------------------------------------

const mailingCrm = (extra = {}) => ({
  tipo: 'finaz',
  id: 'm1',
  client_id: 'c1',
  file_name: 'mailing_finaz.csv',
  file_url: 'c1/finaz/1-mailing_finaz.csv',
  received_at: '2026-10-06T11:00:00.000Z',
  ...extra,
});

test('AUTO-15: mailing CSV do CRM de cliente automático vira ticket com o nome do arquivo e o arquivo recebido', async () => {
  const { fluxo, estado } = montar({ mailings: [mailingCrm()] });

  await fluxo.avancar();

  assert.deepEqual(estado.ticketsCriados, [
    {
      client_id: 'c1',
      mailing_name: 'mailing_finaz',
      campaign_name: '',
      aggressiveness: 'moderada',
      original_file_url: 'c1/finaz/1-mailing_finaz.csv',
      original_file_name: 'mailing_finaz.csv',
      origem_mailing_tipo: 'finaz',
      origem_mailing_id: 'm1',
    },
  ]);
});

test('AUTO-02/AUTO-15: ticket do CRM de cliente não optante é criado sem agressividade', async () => {
  const { fluxo, estado } = montar({
    mailings: [mailingCrm()],
    perfis: [perfilBase({ optante_higienizacao: false })],
  });

  await fluxo.avancar();

  assert.equal(estado.ticketsCriados.length, 1);
  assert.equal(estado.ticketsCriados[0].aggressiveness, null);
});

test('AUTO-16: mailing do CRM de cliente com o automático desligado não vira ticket', async () => {
  const { fluxo, estado } = montar({
    mailings: [mailingCrm()],
    perfis: [perfilBase({ fluxo_automatico: false, fluxo_automatico_desde: null })],
  });

  await fluxo.avancar();

  assert.deepEqual(estado.ticketsCriados, []);
  assert.equal(estado.eventos.length, 0);
});

test('AUTO-17: mailing do CRM que já tem ticket não gera um segundo', async () => {
  const { fluxo, estado } = montar({ mailings: [mailingCrm()], chavesComTicket: ['finaz:m1'] });

  await fluxo.avancar();

  assert.deepEqual(estado.ticketsCriados, []);
});

test('AUTO-17: se outra varredura criou o ticket do mesmo mailing antes, segue sem erro e sem duplicar', async () => {
  const { fluxo, estado } = montar({ mailings: [mailingCrm()], conflitoAoCriarTicket: true });

  await assert.doesNotReject(fluxo.avancar());

  assert.deepEqual(estado.ticketsCriados, []);
  assert.equal(estado.eventos.length, 0);
});

test('AUTO-18: planilha do CRM não vira ticket e gera o evento de pausa com o motivo exato', async () => {
  const { fluxo, estado } = montar({ mailings: [mailingCrm({ file_name: 'base.xlsx' })] });

  await fluxo.avancar();

  assert.deepEqual(estado.ticketsCriados, []);
  assert.deepEqual(estado.eventos, [
    {
      event: 'envio_automatico_pausado',
      ticketId: null,
      clientId: 'c1',
      clientName: 'Cliente Um',
      mailingName: 'base',
      integracao: null,
      registros: null,
      motivo: 'Mailing do CRM em planilha: crie o ticket manualmente',
    },
  ]);
});

test('AUTO-18: a mesma planilha não gera o aviso de novo a cada varredura', async () => {
  const { fluxo, estado } = montar({ mailings: [mailingCrm({ file_name: 'base.xlsx' })] });

  await fluxo.avancar();
  await fluxo.avancar();

  assert.equal(estado.eventos.length, 1);
});
