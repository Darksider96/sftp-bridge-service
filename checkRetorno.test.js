// Testa só a parte pura de checkRetorno.js (isSameReturnFile). O resto do
// módulo depende de supabaseAdmin/sftpClient (I/O real), então exige as env
// vars mínimas pra não derrubar o processo ao dar require (supabaseAdmin.js
// faz process.exit(1) se faltar SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key-for-tests';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSameReturnFile } = require('./checkRetorno');

test('isSameReturnFile: tamanhos identicos sao a mesma duplicata', () => {
  assert.equal(isSameReturnFile(782750, 782750), true);
});

test('isSameReturnFile: diferenca minima (poucos bytes) ainda conta como duplicata', () => {
  assert.equal(isSameReturnFile(782750, 782760), true);
});

test('isSameReturnFile: arquivo bem maior nao e tratado como duplicata', () => {
  // Caso real em producao: retorno completo (4.339.934 bytes) chegou depois
  // do que ja tinha sido processado (3.163.275 bytes) e foi descartado como
  // "duplicado" -- isSameReturnFile tem que dizer que NAO sao o mesmo arquivo.
  assert.equal(isSameReturnFile(4339934, 3163275), false);
});

test('isSameReturnFile: arquivo bem menor tambem nao e tratado como duplicata', () => {
  assert.equal(isSameReturnFile(70295, 989576), false);
});

test('isSameReturnFile: sem tamanho ja salvo pra comparar, nunca assume que e duplicata', () => {
  // Pior caso de erro tem que ser "alerta desnecessario", nunca "dado perdido
  // de novo" -- sem conseguir confirmar o tamanho anterior, trata como
  // divergente (seguro) em vez de duplicata (arriscado).
  assert.equal(isSameReturnFile(1000, null), false);
  assert.equal(isSameReturnFile(1000, undefined), false);
});
