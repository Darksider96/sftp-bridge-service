const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyCodigoColumnCase, applyFinazRule, applyPhoneOverflowRule } = require('./profileRules');

test('applyCodigoColumnCase: minuscula transforma o valor da coluna CODIGO', () => {
  const result = applyCodigoColumnCase([{ CODIGO: 'ABC123', Nome: 'Foo' }], 'lower');
  assert.equal(result[0].CODIGO, 'abc123');
});

test('applyCodigoColumnCase: maiuscula transforma o valor da coluna codigo', () => {
  const result = applyCodigoColumnCase([{ codigo: 'abc123', Nome: 'Foo' }], 'upper');
  assert.equal(result[0].codigo, 'ABC123');
});

test('applyCodigoColumnCase: sem coluna codigo, retorna linhas inalteradas', () => {
  const rows = [{ Nome: 'Foo', Telefone: '11999999999' }];
  assert.deepEqual(applyCodigoColumnCase(rows, 'upper'), rows);
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

test('applyPhoneOverflowRule: exclude remove as colunas de telefone excedentes', () => {
  const result = applyPhoneOverflowRule(withThreePhones(), 2, 'exclude');
  assert.equal('DDD3' in result[0], false);
  assert.equal('Telefone3' in result[0], false);
  assert.equal(result[0].DDD1, '11');
  assert.equal(result[0].DDD2, '21');
});

test('applyPhoneOverflowRule: keep_empty mantem a coluna, so esvazia o valor', () => {
  const result = applyPhoneOverflowRule(withThreePhones(), 2, 'keep_empty');
  assert.equal('DDD3' in result[0], true);
  assert.equal(result[0].DDD3, '');
  assert.equal(result[0].Telefone3, '');
});

test('applyPhoneOverflowRule: sem maxPhoneColumns definido, nao faz nada', () => {
  const rows = withThreePhones();
  assert.deepEqual(applyPhoneOverflowRule(rows, null, 'exclude'), rows);
  assert.deepEqual(applyPhoneOverflowRule(rows, undefined, 'exclude'), rows);
});

test('applyPhoneOverflowRule: limite maior ou igual ao numero de telefones, nao faz nada', () => {
  const rows = withThreePhones();
  assert.deepEqual(applyPhoneOverflowRule(rows, 5, 'exclude'), rows);
});
