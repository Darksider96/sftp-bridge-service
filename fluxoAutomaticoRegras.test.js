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
