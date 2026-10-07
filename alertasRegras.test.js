const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jobsSemRetorno, alertaSemRetorno, alertaDoEventoAutomatico } = require('./alertasRegras');

const AGORA = new Date('2026-09-24T21:30:00.000Z');
const job = (extra = {}) => ({
  id: 'j1',
  ticket_id: 't1',
  status: 'enviado',
  criado_em: '2026-09-24T19:26:36.000Z',
  ...extra,
});

test('ALERT-01: envio há mais de 20 min sem nenhum registro posterior está sem retorno', () => {
  assert.deepEqual(jobsSemRetorno([job()], AGORA), [job()]);
  const ha21min = job({ id: 'j9', ticket_id: 't9', criado_em: '2026-09-24T21:09:00.000Z' });
  assert.deepEqual(jobsSemRetorno([ha21min], AGORA), [ha21min]);
});

test('ALERT-01: envio há 20 min ou menos ainda não está sem retorno', () => {
  const exatos20 = job({ criado_em: '2026-09-24T21:10:00.000Z' });
  const recente = job({ id: 'j2', ticket_id: 't2', criado_em: '2026-09-24T21:25:00.000Z' });
  assert.deepEqual(jobsSemRetorno([exatos20, recente], AGORA), []);
});

test('ALERT-01: envio que já tem registro posterior de retorno não está sem retorno', () => {
  const retorno = job({ id: 'j2', status: 'retorno_recebido', criado_em: '2026-09-24T19:40:00.000Z' });
  assert.deepEqual(jobsSemRetorno([job(), retorno], AGORA), []);
});

test('ALERT-01: registro posterior de OUTRO ticket não conta como retorno deste', () => {
  const outro = job({ id: 'j2', ticket_id: 't2', status: 'concluido', criado_em: '2026-09-24T19:40:00.000Z' });
  assert.deepEqual(jobsSemRetorno([job(), outro], AGORA).map((j) => j.id), ['j1']);
});

test('ALERT-01: reenvio — só o envio mais recente do ticket é avaliado', () => {
  const reenvio = job({ id: 'j2', criado_em: '2026-09-24T20:00:00.000Z' });
  assert.deepEqual(jobsSemRetorno([job(), reenvio], AGORA).map((j) => j.id), ['j2']);
});

test('ALERT-01: envio que nem saiu do nosso lado (pendente) há mais de 20 min também é sinalizado', () => {
  assert.deepEqual(jobsSemRetorno([job({ status: 'pendente' })], AGORA).map((j) => j.id), ['j1']);
});

test('ALERT-01: jobs concluídos ou com falha nunca são "sem retorno"', () => {
  assert.deepEqual(jobsSemRetorno([job({ status: 'concluido' }), job({ id: 'j2', ticket_id: 't2', status: 'falha' })], AGORA), []);
});

test('ALERT-01: alerta de sem retorno leva cliente, mailing e há quantos minutos foi enviado, um por envio', () => {
  const ticket = { id: 't1', mailing_name: '2627' };
  assert.deepEqual(alertaSemRetorno(job(), ticket, 'ME7', '/flag-contato/Retorno', AGORA), {
    tipo: 'sem_retorno',
    chave: 'sem_retorno:j1',
    ticketId: 't1',
    mensagem:
      'Enviado à higienizadora há 123 min e nenhum retorno chegou em /flag-contato/Retorno. Confira se o arquivo foi pra Processado sem gerar retorno.',
    detalhes: { clientName: 'ME7', mailingName: '2627' },
  });
});

test('ALERT-01: envio pendente tem mensagem própria (não chegou a sair)', () => {
  const alerta = alertaSemRetorno(job({ status: 'pendente' }), { id: 't1', mailing_name: '2627' }, 'ME7', '/flag-contato/Retorno', AGORA);
  assert.equal(alerta.mensagem, 'O envio pra higienizadora começou há 123 min e não foi concluído do nosso lado.');
});

const evento = (extra = {}) => ({
  event: 'envio_automatico_pausado',
  ticketId: 't1',
  clientId: 'c1',
  clientName: 'Cliente Um',
  mailingName: 'Base Outubro',
  integracao: null,
  registros: null,
  motivo: 'Envio automático pausado: destino não configurado',
  ...extra,
});

test('ALERT-06: pausa do fluxo automático vira alerta com o motivo', () => {
  assert.deepEqual(alertaDoEventoAutomatico(evento()), {
    tipo: 'envio_pausado',
    chave: 'envio_pausado:t1:Envio automático pausado: destino não configurado',
    ticketId: 't1',
    mensagem: 'Envio automático pausado: destino não configurado',
    detalhes: { clientName: 'Cliente Um', mailingName: 'Base Outubro' },
  });
});

test('ALERT-06: falha do fluxo automático vira alerta com o motivo', () => {
  const alerta = alertaDoEventoAutomatico(
    evento({ event: 'envio_automatico_falhou', motivo: 'Falha no envio automático: Acesso negado', integracao: 'synq' })
  );
  assert.equal(alerta.tipo, 'envio_falhou');
  assert.equal(alerta.mensagem, 'Falha no envio automático: Acesso negado');
  assert.equal(alerta.ticketId, 't1');
});

test('ALERT-06: pausa por aprovação baixa não gera segundo alerta (já existe o de aprovação baixa)', () => {
  assert.equal(alertaDoEventoAutomatico(evento({ motivo: 'Envio automático pausado: aprovação baixa' })), null);
});

test('ALERT-06: envio concluído não é problema e não gera alerta', () => {
  assert.equal(alertaDoEventoAutomatico(evento({ event: 'envio_automatico_concluido', motivo: null })), null);
});

test('ALERT-06: planilha do CRM (sem ticket) vira alerta identificado pelo cliente e pelo mailing', () => {
  const alerta = alertaDoEventoAutomatico(
    evento({ ticketId: null, mailingName: 'base', motivo: 'Mailing do CRM em planilha: crie o ticket manualmente' })
  );
  assert.equal(alerta.ticketId, null);
  assert.equal(alerta.chave, 'envio_pausado:c1:base:Mailing do CRM em planilha: crie o ticket manualmente');
});
