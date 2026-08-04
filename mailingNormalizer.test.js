const { test } = require('node:test');
const assert = require('node:assert/strict');
const Papa = require('papaparse');
const { normalizeMailing, extractDddTelefone, detectIdColumn, detectPhonePairs, parseMailingCsv } = require('./mailingNormalizer');

test('extractDddTelefone: DDD e telefone em colunas separadas', () => {
  assert.deepEqual(extractDddTelefone('11', '999998888'), { ddd: '11', telefone: '999998888' });
});

test('extractDddTelefone: DDD chumbado no telefone (11 dígitos)', () => {
  assert.deepEqual(extractDddTelefone('', '11999998888'), { ddd: '11', telefone: '999998888' });
});

test('extractDddTelefone: DDD chumbado no telefone (10 dígitos, fixo)', () => {
  assert.deepEqual(extractDddTelefone('', '1133334444'), { ddd: '11', telefone: '33334444' });
});

test('extractDddTelefone: remove código do país 55', () => {
  assert.deepEqual(extractDddTelefone('', '5511999998888'), { ddd: '11', telefone: '999998888' });
});

test('extractDddTelefone: remove prefixo de tronco 0', () => {
  assert.deepEqual(extractDddTelefone('', '011999998888'), { ddd: '11', telefone: '999998888' });
});

test('extractDddTelefone: DDD inválido é rejeitado', () => {
  assert.equal(extractDddTelefone('00', '999998888'), null);
  assert.equal(extractDddTelefone('', '00999998888'), null);
});

test('extractDddTelefone: telefone com todos dígitos iguais é rejeitado', () => {
  assert.equal(extractDddTelefone('11', '999999999'), null);
});

test('extractDddTelefone: telefone vazio é rejeitado', () => {
  assert.equal(extractDddTelefone('11', ''), null);
  assert.equal(extractDddTelefone('', ''), null);
});

test('detectIdColumn: prioriza CPF quando presente', () => {
  assert.equal(detectIdColumn(['Nome', 'CPF', 'Telefone']), 'CPF');
});

test('detectIdColumn: usa primeira coluna como fallback', () => {
  assert.equal(detectIdColumn(['Codigo Interno', 'Telefone']), 'Codigo Interno');
});

test('detectPhonePairs: pareia por sufixo numérico', () => {
  const pairs = detectPhonePairs(['CPF', 'DDD 1', 'Telefone 1', 'DDD 2', 'Telefone 2'], 'CPF');
  assert.deepEqual(pairs, [
    { ddd: 'DDD 1', tel: 'Telefone 1' },
    { ddd: 'DDD 2', tel: 'Telefone 2' },
  ]);
});

test('detectPhonePairs: telefone sem DDD pareado ainda entra na lista (DDD embutido)', () => {
  const pairs = detectPhonePairs(['CPF', 'Celular', 'Tel Residencial'], 'CPF');
  assert.deepEqual(pairs, [
    { ddd: null, tel: 'Celular' },
    { ddd: null, tel: 'Tel Residencial' },
  ]);
});

test('normalizeMailing: caso simples, um telefone por cliente', () => {
  const rows = [
    { CPF: '11111111111', DDD: '11', Telefone: '999998888' },
    { CPF: '22222222222', DDD: '21', Telefone: '988887777' },
  ];
  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [
    { id: '11111111111', ddd: '11', telefone: '999998888' },
    { id: '22222222222', ddd: '21', telefone: '988887777' },
  ]);
  assert.equal(report.phonesExtracted, 2);
  assert.equal(report.rowsWithoutPhone, 0);
});

test('normalizeMailing: DDD chumbado no telefone, sem coluna DDD', () => {
  const rows = [{ CPF: '11111111111', Telefone: '11999998888' }];
  const { rows: out } = normalizeMailing(rows);
  assert.deepEqual(out, [{ id: '11111111111', ddd: '11', telefone: '999998888' }]);
});

test('normalizeMailing: mais de um telefone por cliente vira uma linha por telefone', () => {
  const rows = [
    { CPF: '11111111111', Celular: '11999998888', 'Tel Residencial': '1133334444' },
  ];
  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [
    { id: '11111111111', ddd: '11', telefone: '999998888' },
    { id: '11111111111', ddd: '11', telefone: '33334444' },
  ]);
  assert.equal(report.phonesExtracted, 2);
  assert.equal(report.rowsWithPhone, 1);
});

test('normalizeMailing: telefone duplicado na mesma linha não repete', () => {
  const rows = [
    { CPF: '11111111111', Celular: '11999998888', Celular2: '11999998888' },
  ];
  const { rows: out, report } = normalizeMailing(rows);
  assert.equal(out.length, 1);
  assert.equal(report.phonesExtracted, 1);
});

test('normalizeMailing: dedupeAcrossFile descarta telefone repetido entre clientes diferentes', () => {
  const rows = [
    { CPF: '11111111111', Telefone: '11999998888' },
    { CPF: '22222222222', Telefone: '11999998888' },
  ];
  const { rows: out, report } = normalizeMailing(rows, { dedupeAcrossFile: true });
  assert.equal(out.length, 1);
  assert.equal(report.duplicatesSkipped, 1);
});

test('normalizeMailing: linha sem telefone válido é contabilizada mas não gera saída', () => {
  const rows = [
    { CPF: '11111111111', Telefone: '123' },
    { CPF: '22222222222', Telefone: '11999998888' },
  ];
  const { rows: out, report } = normalizeMailing(rows);
  assert.equal(out.length, 1);
  assert.equal(report.rowsWithoutPhone, 1);
  assert.equal(report.invalidSkipped, 1);
});

test('normalizeMailing: array vazio retorna vazio sem lançar erro', () => {
  const { rows: out, report } = normalizeMailing([]);
  assert.deepEqual(out, []);
  assert.equal(report.totalRows, 0);
});

test('normalizeMailing: sem nenhuma coluna de telefone lança erro', () => {
  assert.throws(() => normalizeMailing([{ CPF: '111', Nome: 'Fulano' }]), /Nenhuma coluna de telefone/);
});

test('normalizeMailing: respeita idColumn explícito', () => {
  const rows = [{ Matricula: 'A1', CPF: '11111111111', Telefone: '11999998888' }];
  const { rows: out } = normalizeMailing(rows, { idColumn: 'Matricula' });
  assert.equal(out[0].id, 'A1');
});

test('extractDddTelefone: celular de 9 dígitos precisa começar com 9', () => {
  assert.equal(extractDddTelefone('11', '811687681'), null);
  assert.deepEqual(extractDddTelefone('11', '911687681'), { ddd: '11', telefone: '911687681' });
});

test('extractDddTelefone: fixo de 8 dígitos não pode começar com 0 ou 1', () => {
  assert.equal(extractDddTelefone('11', '01687681'), null);
  assert.equal(extractDddTelefone('11', '11687681'), null);
  assert.deepEqual(extractDddTelefone('11', '21687681'), { ddd: '11', telefone: '21687681' });
});

test('extractDddTelefone: coluna de ID de 11 dígitos não é confundida com telefone chumbado', () => {
  // Mesmo formato/tamanho de um celular com DDD embutido, mas o "resto" começa
  // com 0 (não é 9), então não deve validar como telefone.
  assert.equal(extractDddTelefone('', '15011687681'), null);
});

// Layouts reais de clientes (dados fabricados, mesma estrutura) — regressão
// para os formatos observados em produção.
function parseSemicolon(csv) {
  return Papa.parse(csv, { header: true, delimiter: ';', skipEmptyLines: true }).data;
}

test('layout real: identificador;nome;telefone1;telefone2 (DDD chumbado, sem coluna DDD)', () => {
  const rows = parseSemicolon(
    'identificador;nome;telefone1;telefone2\n' +
    '10000001;FULANO DA SILVA;69912340001;69984380002\n' +
    '10000002;CICLANA SOUZA;96912340003;47999510004'
  );
  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [
    { id: '10000001', ddd: '69', telefone: '912340001' },
    { id: '10000001', ddd: '69', telefone: '984380002' },
    { id: '10000002', ddd: '96', telefone: '912340003' },
    { id: '10000002', ddd: '47', telefone: '999510004' },
  ]);
  assert.equal(report.invalidSkipped, 0);
});

test('layout real: telefone2 em branco não conta como inválido', () => {
  const rows = parseSemicolon(
    'identificador;nome;telefone1;telefone2\n' +
    '20000001;BELTRANO ALVES;61981080001;'
  );
  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [{ id: '20000001', ddd: '61', telefone: '981080001' }]);
  assert.equal(report.invalidSkipped, 0);
  assert.equal(report.rowsWithoutPhone, 0);
});

test('layout real: cabeçalhos duplicados ddd;tel;ddd;tel;ddd;tel + colunas extras não-telefone', () => {
  const rows = parseSemicolon(
    'cpf;nome;ddd;tel;ddd;tel;ddd;tel;esp;dt-nasc;idade;vl-atual-benef;margem_dip;margem_rmc;total;ddb\n' +
    '30000000001;FULANO DE TAL;17;991110001;17;981110002;17;971110003;1;01/01/1970;50;1000,00;100,00;200,00;300,00'
  );
  // Confirma que o Papa realmente renomeia os duplicados (ddd, ddd_1, ddd_2 / tel, tel_1, tel_2) —
  // é essa renomeação que o pareamento por sufixo numérico depende.
  assert.deepEqual(Object.keys(rows[0]).filter((h) => h.startsWith('ddd') || h.startsWith('tel')), [
    'ddd', 'tel', 'ddd_1', 'tel_1', 'ddd_2', 'tel_2',
  ]);

  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [
    { id: '30000000001', ddd: '17', telefone: '991110001' },
    { id: '30000000001', ddd: '17', telefone: '981110002' },
    { id: '30000000001', ddd: '17', telefone: '971110003' },
  ]);
  assert.equal(report.invalidSkipped, 0);
  // Nenhuma coluna extra (esp, dt-nasc, idade, margem_*, total, ddb) deve ser
  // confundida com telefone — "total" e "ddb" quase colidem com "tel"/"ddd".
  assert.equal(report.phonesExtracted, 3);
});

test('layout real: TELEFONE1..5 sem coluna DDD, identificador é CODIGO (não NOME)', () => {
  const rows = parseSemicolon(
    'TELEFONE1;TELEFONE2;TELEFONE3;TELEFONE4;TELEFONE5;NOME;CODIGO\n' +
    '31912340001;31982600002;;;;FULANO DA SILVA;COD-AAA111\n' +
    '19984350003;;;;;CICLANA SOUZA;COD-BBB222\n' +
    '15997680004;15996410005;;;;BELTRANO ALVES;COD-CCC333'
  );
  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [
    { id: 'COD-AAA111', ddd: '31', telefone: '912340001' },
    { id: 'COD-AAA111', ddd: '31', telefone: '982600002' },
    { id: 'COD-BBB222', ddd: '19', telefone: '984350003' },
    { id: 'COD-CCC333', ddd: '15', telefone: '997680004' },
    { id: 'COD-CCC333', ddd: '15', telefone: '996410005' },
  ]);
  assert.equal(report.invalidSkipped, 0);
});

test('layout real "finaz": CSV sem nenhuma linha de cabeçalho, id;nome;5 telefones', () => {
  const csv = [
    '30000000001;FULANO DA SILVA;41912340001;;;;',
    '30000000002;CICLANA SOUZA;11974950002;11956740003;;;',
    '30000000003;BELTRANO ALVES;11972620004;11980890005;;;',
    '30000000004;FULANA PEREIRA;11953950006;11995620007;;;',
  ].join('\n');

  const rows = parseMailingCsv(csv);
  // A primeira linha (dado de verdade) não pode ter sido perdida como se fosse cabeçalho.
  assert.equal(rows.length, 4);
  assert.equal(rows[0].id, '30000000001');

  const { rows: out, report } = normalizeMailing(rows);
  assert.deepEqual(out, [
    { id: '30000000001', ddd: '41', telefone: '912340001' },
    { id: '30000000002', ddd: '11', telefone: '974950002' },
    { id: '30000000002', ddd: '11', telefone: '956740003' },
    { id: '30000000003', ddd: '11', telefone: '972620004' },
    { id: '30000000003', ddd: '11', telefone: '980890005' },
    { id: '30000000004', ddd: '11', telefone: '953950006' },
    { id: '30000000004', ddd: '11', telefone: '995620007' },
  ]);
  assert.equal(report.invalidSkipped, 0);
});

test('parseMailingCsv: arquivo com cabeçalho de verdade continua sendo lido como cabeçalho', () => {
  const csv = 'CPF;Nome;Telefone\n11111111111;Fulano;11999998888';
  const rows = parseMailingCsv(csv);
  assert.deepEqual(rows, [{ CPF: '11111111111', Nome: 'Fulano', Telefone: '11999998888' }]);
});
