const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MOTIVOS, resolverDestino } = require('./fluxoAutomaticoRegras');

const CLIENTE = 'cliente-1';
const perfil = (extra = {}) => ({ id: CLIENTE, auto_integracao_id: 'int-1', auto_campanha_id: null, ...extra });
const synq = (extra = {}) => ({
  id: 'int-1',
  client_id: CLIENTE,
  integration_type: 'synq',
  active: true,
  config: { api_url: 'https://synq', api_token: 't' },
  ...extra,
});
const dazsoft = (extra = {}) => ({
  id: 'int-1',
  client_id: CLIENTE,
  integration_type: 'dazsoft',
  active: true,
  config: { campanhas: [{ nome: 'Vendas', campanha_id: '77' }] },
  ...extra,
});

test('MOTIVOS: textos exatos definidos na spec', () => {
  assert.equal(MOTIVOS.APROVACAO_BAIXA, 'Envio automático pausado: aprovação baixa');
  assert.equal(MOTIVOS.DESTINO, 'Envio automático pausado: destino não configurado');
  assert.equal(MOTIVOS.SEM_REGISTROS, 'Envio automático pausado: arquivo sem registros');
  assert.equal(MOTIVOS.FALHA, 'Falha no envio automático');
  assert.equal(MOTIVOS.RETORNO_MAIOR, 'Retorno maior chegou após o envio — revisar');
  assert.equal(MOTIVOS.PLANILHA, 'Mailing do CRM em planilha: crie o ticket manualmente');
});

test('AUTO-06: integração Synq ativa do próprio cliente é destino válido', () => {
  assert.deepEqual(resolverDestino(perfil(), synq()), {
    ok: true,
    tipo: 'synq',
    integracaoId: 'int-1',
    campanhaId: null,
  });
});

test('AUTO-07: Dazsoft com campanha cadastrada na integração é destino válido e leva a campanha', () => {
  assert.deepEqual(resolverDestino(perfil({ auto_campanha_id: '77' }), dazsoft()), {
    ok: true,
    tipo: 'dazsoft',
    integracaoId: 'int-1',
    campanhaId: '77',
  });
});

test('AUTO-07: Dazsoft no formato antigo (campanha_id único na config) também é aceito', () => {
  const integracao = dazsoft({ config: { campanha_id: '55' } });
  assert.equal(resolverDestino(perfil({ auto_campanha_id: '55' }), integracao).ok, true);
});

test('AUTO-20: cliente sem destino configurado não tem destino válido', () => {
  assert.deepEqual(resolverDestino(perfil({ auto_integracao_id: null }), null), { ok: false });
});

test('AUTO-20: integração removida (não encontrada) não é destino válido', () => {
  assert.deepEqual(resolverDestino(perfil(), null), { ok: false });
});

test('AUTO-20: integração desativada não é destino válido', () => {
  assert.deepEqual(resolverDestino(perfil(), synq({ active: false })), { ok: false });
});

test('AUTO-20: integração de outro cliente não é destino válido', () => {
  assert.deepEqual(resolverDestino(perfil(), synq({ client_id: 'outro-cliente' })), { ok: false });
});

test('AUTO-06: Argus não é destino do automático', () => {
  assert.deepEqual(resolverDestino(perfil(), synq({ integration_type: 'argus' })), { ok: false });
});

test('AUTO-07: Dazsoft sem campanha escolhida não é destino válido', () => {
  assert.deepEqual(resolverDestino(perfil({ auto_campanha_id: null }), dazsoft()), { ok: false });
});

test('AUTO-20: campanha Dazsoft que não está mais cadastrada não é destino válido', () => {
  assert.deepEqual(resolverDestino(perfil({ auto_campanha_id: '99' }), dazsoft()), { ok: false });
});

const {
  deveSegurarPorAprovacao,
  contarRegistros,
  envioTravado,
  nomesParaEnvio,
} = require('./fluxoAutomaticoRegras');

test('AUTO-19: retorno finalizado com aviso de aprovação baixa segura o envio', () => {
  const job = { status: 'concluido', erro_mensagem: 'Percentual de aprovação baixo (2644/30000 = 8.8%, mínimo esperado 30%)' };
  assert.equal(deveSegurarPorAprovacao(job), true);
});

test('AUTO-11: retorno finalizado sem aviso não segura o envio', () => {
  assert.equal(deveSegurarPorAprovacao({ status: 'concluido', erro_mensagem: null }), false);
});

test('AUTO-21: arquivo só com cabeçalho tem zero registros', () => {
  assert.equal(contarRegistros('ID;NOME;TELEFONE\n'), 0);
});

test('AUTO-21: arquivo vazio tem zero registros', () => {
  assert.equal(contarRegistros(''), 0);
});

test('AUTO-21: arquivo com cabeçalho conta só as linhas de dados', () => {
  assert.equal(contarRegistros('ID;NOME;TELEFONE\n1;Ana;11987654321\n2;Bia;21987654321\n'), 2);
});

test('AUTO-21: arquivo sem cabeçalho (layout finaz) conta todas as linhas', () => {
  assert.equal(contarRegistros('1;Ana Souza;11987654321\n2;Bia Lima;21987654321\n'), 2);
});

test('AUTO-24: envio parado em "enviando" há mais de 10 minutos está travado', () => {
  const agora = new Date('2026-10-06T12:00:00.000Z');
  assert.equal(envioTravado('2026-10-06T11:49:59.000Z', agora), true);
});

test('AUTO-24: envio em andamento há 10 minutos ou menos não está travado', () => {
  const agora = new Date('2026-10-06T12:00:00.000Z');
  assert.equal(envioTravado('2026-10-06T11:50:00.000Z', agora), false);
  assert.equal(envioTravado('2026-10-06T11:59:00.000Z', agora), false);
});

test('nome do envio: arquivo higienizado vai com o próprio nome e o mailing sem a extensão', () => {
  const ticket = { processed_file_name: '2627_HIG_MODERADA.csv', original_file_name: '2526.csv', mailing_name: '2627' };
  assert.deepEqual(nomesParaEnvio(ticket, true), { fileName: '2627_HIG_MODERADA.csv', mailingName: '2627_HIG_MODERADA' });
});

test('nome do envio: sem higienização usa o arquivo original e o nome do mailing', () => {
  const ticket = { processed_file_name: null, original_file_name: 'base.csv', mailing_name: 'Base Outubro' };
  assert.deepEqual(nomesParaEnvio(ticket, false), { fileName: 'base.csv', mailingName: 'Base_Outubro' });
});

test('nome do envio: acento é removido e espaço vira "_", como no envio manual', () => {
  const ticket = { processed_file_name: 'Campanha São João_HIG_MODERADA.csv', original_file_name: 'x.csv', mailing_name: 'x' };
  assert.deepEqual(nomesParaEnvio(ticket, true), {
    fileName: 'Campanha_Sao_Joao_HIG_MODERADA.csv',
    mailingName: 'Campanha_Sao_Joao_HIG_MODERADA',
  });
});

const { ehPlanilha, nomeTicketDoMailing, mailingsParaTicket } = require('./fluxoAutomaticoRegras');

const LIGADO_EM = '2026-10-06T10:00:00.000Z';
const perfisCrm = [
  { id: 'auto', fluxo_automatico: true, fluxo_automatico_desde: LIGADO_EM },
  { id: 'manual', fluxo_automatico: false, fluxo_automatico_desde: null },
];
const mailing = (extra = {}) => ({
  tipo: 'finaz',
  id: 'm1',
  client_id: 'auto',
  file_name: 'mailing_finaz.csv',
  file_url: 'auto/finaz/1-mailing_finaz.csv',
  received_at: '2026-10-06T11:00:00.000Z',
  ...extra,
});

test('AUTO-18: .xlsx e .xls são planilha; .csv não', () => {
  assert.equal(ehPlanilha('base.xlsx'), true);
  assert.equal(ehPlanilha('BASE.XLS'), true);
  assert.equal(ehPlanilha('base.csv'), false);
});

test('AUTO-15: o ticket leva o nome do arquivo sem a extensão', () => {
  assert.equal(nomeTicketDoMailing('mailing_finaz.csv'), 'mailing_finaz');
});

test('AUTO-15: mailing CSV de cliente automático, recebido depois de ligar, vira ticket', () => {
  const m = mailing();
  assert.deepEqual(mailingsParaTicket([m], perfisCrm, new Set()), { criar: [m], planilhas: [] });
});

test('AUTO-16: mailing de cliente com o automático desligado não vira ticket', () => {
  const resultado = mailingsParaTicket([mailing({ client_id: 'manual' })], perfisCrm, new Set());
  assert.deepEqual(resultado, { criar: [], planilhas: [] });
});

test('AUTO-17: mailing que já gerou ticket não gera outro', () => {
  const resultado = mailingsParaTicket([mailing()], perfisCrm, new Set(['finaz:m1']));
  assert.deepEqual(resultado, { criar: [], planilhas: [] });
});

test('AUTO-17: o mesmo id em outra origem do CRM é outro mailing', () => {
  const m = mailing({ tipo: 'vanguard' });
  assert.deepEqual(mailingsParaTicket([m], perfisCrm, new Set(['finaz:m1'])).criar, [m]);
});

test('AUTO-27: mailing recebido antes de o automático ser ligado não vira ticket', () => {
  const antigo = mailing({ received_at: '2026-10-06T09:59:59.000Z' });
  assert.deepEqual(mailingsParaTicket([antigo], perfisCrm, new Set()), { criar: [], planilhas: [] });
});

test('AUTO-18: planilha do CRM de cliente automático não vira ticket e é sinalizada', () => {
  const planilha = mailing({ file_name: 'base.xlsx' });
  assert.deepEqual(mailingsParaTicket([planilha], perfisCrm, new Set()), { criar: [], planilhas: [planilha] });
});

test('AUTO-16: planilha de cliente manual não é sinalizada', () => {
  const planilha = mailing({ client_id: 'manual', file_name: 'base.xlsx' });
  assert.deepEqual(mailingsParaTicket([planilha], perfisCrm, new Set()), { criar: [], planilhas: [] });
});

const { aoReprocessar } = require('./fluxoAutomaticoRegras');

test('AUTO-25: retorno maior reprocessa ticket já enviado → pausa com o motivo exato e avisa', () => {
  assert.deepEqual(aoReprocessar({ fluxo_automatico: true, auto_status: 'enviado', auto_motivo: null }), {
    campos: { auto_status: 'pausado', auto_motivo: 'Retorno maior chegou após o envio — revisar' },
    avisar: true,
  });
});

test('AUTO-25: retorno maior durante o envio em andamento também pausa e avisa', () => {
  assert.deepEqual(aoReprocessar({ fluxo_automatico: true, auto_status: 'enviando', auto_motivo: null }), {
    campos: { auto_status: 'pausado', auto_motivo: 'Retorno maior chegou após o envio — revisar' },
    avisar: true,
  });
});

test('premissa: retorno maior depois de pausa por aprovação baixa faz o ticket voltar a seguir sozinho', () => {
  const ticket = { fluxo_automatico: true, auto_status: 'pausado', auto_motivo: 'Envio automático pausado: aprovação baixa' };
  assert.deepEqual(aoReprocessar(ticket), { campos: { auto_status: 'higienizando', auto_motivo: null }, avisar: false });
});

test('AUTO-25: ticket pausado por outro motivo continua pausado no reprocessamento', () => {
  const ticket = { fluxo_automatico: true, auto_status: 'pausado', auto_motivo: 'Envio automático pausado: destino não configurado' };
  assert.equal(aoReprocessar(ticket), null);
});

test('AUTO-25: ticket ainda não enviado segue o fluxo normal no reprocessamento', () => {
  assert.equal(aoReprocessar({ fluxo_automatico: true, auto_status: 'higienizando', auto_motivo: null }), null);
});

test('AUTO-13: ticket manual não é afetado pelo reprocessamento', () => {
  assert.equal(aoReprocessar({ fluxo_automatico: false, auto_status: null, auto_motivo: null }), null);
});
