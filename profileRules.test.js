const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyVanguardPattern,
  applyFinazRule,
  applyPhoneOverflowRule,
  mergePhoneColumns,
  buildFinalFileName,
} = require('./profileRules');

test('applyVanguardPattern: habilitado transforma o valor da coluna CODIGO para minuscula', () => {
  const result = applyVanguardPattern([{ CODIGO: 'ABC123', Nome: 'Foo' }], true);
  assert.equal(result[0].CODIGO, 'abc123');
});

test('applyVanguardPattern: desabilitado nao mexe na coluna', () => {
  const rows = [{ codigo: 'ABC123', Nome: 'Foo' }];
  assert.deepEqual(applyVanguardPattern(rows, false), rows);
});

test('applyVanguardPattern: sem coluna codigo, retorna linhas inalteradas', () => {
  const rows = [{ Nome: 'Foo', Telefone: '11999999999' }];
  assert.deepEqual(applyVanguardPattern(rows, true), rows);
});

test('applyFinazRule: duplica a primeira coluna que bate com id/codigo/finaz no inicio do arquivo', () => {
  const rows = [{ Nome: 'Foo', Codigo: 'ABC123', Telefone: '11999999999' }];
  const result = applyFinazRule(rows);

  assert.equal(result[0].CodigoFinaz, 'ABC123');
  assert.equal(result[0].ProspeccaoId, 'ABC123');
  assert.equal('Codigo' in result[0], false);
  assert.deepEqual(Object.keys(result[0]), ['CodigoFinaz', 'ProspeccaoId', 'Nome', 'Telefone']);
});

test('applyFinazRule: sem coluna id/codigo/finaz, usa a primeira coluna como fallback', () => {
  const rows = [{ Nome: 'Foo', Telefone: '11999999999' }];
  const result = applyFinazRule(rows);

  assert.equal(result[0].CodigoFinaz, 'Foo');
  assert.equal(result[0].ProspeccaoId, 'Foo');
  assert.equal('Nome' in result[0], false);
});

test('applyFinazRule: array vazio retorna vazio', () => {
  assert.deepEqual(applyFinazRule([]), []);
});

function withThreePhones() {
  return [{
    CPF: '1',
    DDD1: '11',
    Telefone1: '999999999',
    DDD2: '21',
    Telefone2: '988888888',
    DDD3: '31',
    Telefone3: '977777777',
  }];
}

test('applyPhoneOverflowRule: exclude remove todas as colunas de telefone alem da primeira', () => {
  const result = applyPhoneOverflowRule(withThreePhones(), 'exclude');
  assert.equal('DDD2' in result[0], false);
  assert.equal('Telefone2' in result[0], false);
  assert.equal('DDD3' in result[0], false);
  assert.equal('Telefone3' in result[0], false);
  assert.equal(result[0].DDD1, '11');
  assert.equal(result[0].Telefone1, '999999999');
});

test('applyPhoneOverflowRule: keep_empty mantem as colunas, so esvazia o valor', () => {
  const result = applyPhoneOverflowRule(withThreePhones(), 'keep_empty');
  assert.equal('DDD2' in result[0], true);
  assert.equal(result[0].DDD2, '');
  assert.equal(result[0].Telefone3, '');
  assert.equal(result[0].DDD1, '11');
});

test('applyPhoneOverflowRule: array vazio retorna vazio', () => {
  assert.deepEqual(applyPhoneOverflowRule([], 'exclude'), []);
});

test('applyPhoneOverflowRule: um so telefone, nao ha excedente pra tratar', () => {
  const rows = [{ CPF: '1', DDD: '11', Telefone: '999999999' }];
  assert.deepEqual(applyPhoneOverflowRule(rows, 'exclude'), rows);
});

test('mergePhoneColumns: funde DDD e Telefone numa coluna so, mantendo a posicao do Telefone', () => {
  const rows = [{ CPF: '1', DDD: '11', Telefone: '999999999', Nome: 'Foo' }];
  const result = mergePhoneColumns(rows);

  assert.equal('DDD' in result[0], false);
  assert.equal(result[0].Telefone, '11999999999');
  assert.deepEqual(Object.keys(result[0]), ['CPF', 'Telefone', 'Nome']);
});

test('mergePhoneColumns: limpa caracteres nao numericos antes de fundir', () => {
  const rows = [{ DDD: '(11)', Telefone: '99999-9999' }];
  const result = mergePhoneColumns(rows);
  assert.equal(result[0].Telefone, '11999999999');
});

test('mergePhoneColumns: layout "junto" (sem coluna DDD separada) nao muda nada', () => {
  const rows = [{ CPF: '1', Telefone: '11999999999' }];
  assert.deepEqual(mergePhoneColumns(rows), rows);
});

test('mergePhoneColumns: array vazio retorna vazio', () => {
  assert.deepEqual(mergePhoneColumns([]), []);
});

test('buildFinalFileName: sufixo MODERADA antes da extensao', () => {
  assert.equal(buildFinalFileName('36k.csv', 'MODERADA'), '36k_HIG_MODERADA.csv');
});

test('buildFinalFileName: sufixo AGRESSIVA antes da extensao', () => {
  assert.equal(buildFinalFileName('mailing.csv', 'AGRESSIVA'), 'mailing_HIG_AGRESSIVA.csv');
});

test('buildFinalFileName: arquivo sem extensao, sufixo vai no final', () => {
  assert.equal(buildFinalFileName('mailing', 'MODERADA'), 'mailing_HIG_MODERADA');
});
