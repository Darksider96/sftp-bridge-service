const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processCentrifugeReturn } = require('./csvProcessor');
const { parseMailingCsv } = require('./mailingNormalizer');

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

test('arquivo original sem cabeçalho (layout "finaz"): PROCV ainda casa os telefones', () => {
  // Antes da correção, originalData vinha de um Papa.parse cru com header:true — a primeira
  // linha virava cabeçalho por engano e o pareamento de colunas não achava nenhum telefone,
  // então TODO cliente era descartado do resultado final, mesmo com score aprovado.
  const originalCsv = [
    '30000000001;FULANO DA SILVA;41912340001;',
    '30000000002;CICLANA SOUZA;11974950002;11956740003',
  ].join('\n');
  const originalRows = parseMailingCsv(originalCsv);
  assert.equal(originalRows.length, 2); // a primeira linha não pode ter sumido

  const returnedRows = returned([
    ['41', '912340001', 5], // aprovado
    ['11', '974950002', 1], // reprovado (score baixo)
    ['11', '956740003', 5], // aprovado
  ]);

  const result = processCentrifugeReturn(originalRows, returnedRows, 'AGRESSIVA');

  // RF-003: só o primeiro telefone detectado decide a aprovação (é o único
  // que de fato foi enviado à higienização). O cliente 1 tem seu único
  // telefone aprovado -> entra. O cliente 2 tem o PRIMEIRO telefone
  // reprovado -> não entra, mesmo tendo um segundo telefone aprovado.
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '30000000001');
});
