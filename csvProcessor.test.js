const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processCentrifugeReturn } = require('./csvProcessor');

function original(rows) {
  return rows.map(([ddd, telefone, nome]) => ({ DDD: ddd, Telefone: telefone, Nome: nome }));
}

function returned(rows) {
  return rows.map(([ddd, telefone, score]) => ({ DDD: ddd, Telefone: telefone, Score: String(score) }));
}

test('AGRESSIVA aceita score >= 3 e rejeita score 2', () => {
  const orig = original([
    ['11', '900000001', 'Score 3'],
    ['11', '900000002', 'Score 2'],
  ]);
  const ret = returned([
    ['11', '900000001', 3],
    ['11', '900000002', 2],
  ]);

  const result = processCentrifugeReturn(orig, ret, 'AGRESSIVA');

  assert.equal(result.length, 1);
  assert.equal(result[0].Nome, 'Score 3');
});

test('MODERADA aceita score >= 2 e rejeita score 1', () => {
  const orig = original([
    ['11', '900000001', 'Score 2'],
    ['11', '900000002', 'Score 1'],
  ]);
  const ret = returned([
    ['11', '900000001', 2],
    ['11', '900000002', 1],
  ]);

  const result = processCentrifugeReturn(orig, ret, 'MODERADA');

  assert.equal(result.length, 1);
  assert.equal(result[0].Nome, 'Score 2');
});

test('linha original cujo telefone não está na lista aprovada é excluída', () => {
  const orig = original([
    ['11', '900000001', 'Não retornou'],
  ]);
  const ret = returned([
    ['11', '999999999', 5],
  ]);

  const result = processCentrifugeReturn(orig, ret, 'AGRESSIVA');

  assert.deepEqual(result, []);
});

test('originalData vazio retorna []', () => {
  const ret = returned([['11', '900000001', 5]]);
  assert.deepEqual(processCentrifugeReturn([], ret, 'AGRESSIVA'), []);
});

test('returnedData vazio retorna []', () => {
  const orig = original([['11', '900000001', 'Cliente']]);
  assert.deepEqual(processCentrifugeReturn(orig, [], 'AGRESSIVA'), []);
});
