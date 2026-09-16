// Testa só a parte pura de checkRetorno.js (isSameReturnFile). O resto do
// módulo depende de supabaseAdmin/sftpClient (I/O real), então exige as env
// vars mínimas pra não derrubar o processo ao dar require (supabaseAdmin.js
// faz process.exit(1) se faltar SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key-for-tests';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSameReturnFile,
  shouldReplaceStagedReturn,
  computeConfirmationCutoff,
  classifyDivergentReturn,
  CONFIRMATION_WINDOW_MS,
} = require('./checkRetorno');

test('isSameReturnFile: tamanhos identicos sao a mesma duplicata', () => {
  assert.equal(isSameReturnFile(782750, 782750), true);
});

test('isSameReturnFile: diferenca minima (poucos bytes) ainda conta como duplicata', () => {
  assert.equal(isSameReturnFile(782750, 782760), true);
});

test('isSameReturnFile: diferenca logo acima da tolerancia (65 bytes) ja nao e duplicata', () => {
  assert.equal(isSameReturnFile(782750, 782815), false);
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

test('shouldReplaceStagedReturn: arquivo maior chegando durante a janela substitui o staged', () => {
  // Caso real: ticket de 12k, arquivo intermediario staged (2.129 linhas),
  // arquivo completo chega ~1min15s depois, bem maior -- tem que substituir.
  assert.equal(shouldReplaceStagedReturn(403595, 74000), true);
});

test('shouldReplaceStagedReturn: arquivo igual ou menor nao substitui o staged', () => {
  assert.equal(shouldReplaceStagedReturn(74000, 74000), false);
  assert.equal(shouldReplaceStagedReturn(50000, 74000), false);
});

test('shouldReplaceStagedReturn: sem tamanho anterior conhecido, substitui (nada foi exposto ainda)', () => {
  // Diferente de classifyDivergentReturn (pos-finalizacao): aqui ainda nao
  // existe risco de negocio em aceitar o novo arquivo, entao o "nao sei" nao
  // precisa ser tratado com cautela -- so reprocessaria de novo se estiver
  // errado, sem nunca ter exposto nada ao ticket.
  assert.equal(shouldReplaceStagedReturn(1000, null), true);
  assert.equal(shouldReplaceStagedReturn(1000, undefined), true);
});

test('computeConfirmationCutoff: subtrai exatamente a janela de confirmacao do "agora" informado', () => {
  const now = new Date('2026-09-16T18:00:00.000Z');
  const cutoff = computeConfirmationCutoff(now);
  assert.equal(cutoff, new Date(now.getTime() - CONFIRMATION_WINDOW_MS).toISOString());
  assert.equal(cutoff, '2026-09-16T17:57:00.000Z');
});

test('computeConfirmationCutoff: sem "agora" informado, usa o relogio real (nao trava/erra)', () => {
  const cutoff = computeConfirmationCutoff();
  assert.ok(new Date(cutoff).getTime() < Date.now());
});

test('classifyDivergentReturn: tamanho identico -> duplicate', () => {
  assert.equal(classifyDivergentReturn(782750, 782750), 'duplicate');
});

test('classifyDivergentReturn: arquivo maior -> reprocess (seguro reprocessar sozinho)', () => {
  // Padrao observado em 100% dos 7 tickets reais auditados: arquivo maior
  // chegando depois de um ticket ja concluido sempre foi o resultado mais
  // completo, nunca um problema.
  assert.equal(classifyDivergentReturn(4339934, 3163275), 'reprocess');
});

test('classifyDivergentReturn: arquivo menor -> alert (nao reprocessa sozinho)', () => {
  assert.equal(classifyDivergentReturn(70295, 989576), 'alert');
});

test('classifyDivergentReturn: tamanho anterior desconhecido -> alert (cautela, ja foi exposto ao ticket)', () => {
  // Diferente de shouldReplaceStagedReturn: aqui o ticket JA esta finalizado
  // e o cliente pode ja ter agido sobre o resultado anterior, entao "nao sei
  // se e melhor" tem que ser tratado com cautela, nao aceito de graca.
  assert.equal(classifyDivergentReturn(1000, null), 'alert');
});
