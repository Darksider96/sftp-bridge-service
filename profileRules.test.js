const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyVanguardPattern,
  applyFinazRule,
  applyPhoneOverflowRule,
  mergePhoneColumns,
  buildFinalFileName,
} = require('./profileRules');

test('applyVanguardPattern: habilitado deixa o CABECALHO da coluna CODIGO em minuscula, sem mexer no valor', () => {
  const result = applyVanguardPattern([{ CODIGO: 'ABC123', Nome: 'Foo' }], true);
  assert.equal('CODIGO' in result[0], false);
  assert.equal(result[0].codigo, 'ABC123');
  assert.deepEqual(Object.keys(result[0]), ['codigo', 'Nome']);
});

test('applyVanguardPattern: cabecalho ja minusculo fica igual (no-op)', () => {
  const rows = [{ codigo: 'ABC123', Nome: 'Foo' }];
  assert.deepEqual(applyVanguardPattern(rows, true), rows);
});

test('applyVanguardPattern: desabilitado nao mexe na coluna', () => {
  const rows = [{ CODIGO: 'ABC123', Nome: 'Foo' }];
  assert.deepEqual(applyVanguardPattern(rows, false), rows);
});

test('applyVanguardPattern: sem coluna codigo, retorna linhas inalteradas', () => {
  const rows = [{ Nome: 'Foo', Telefone: '11999999999' }];
  assert.deepEqual(applyVanguardPattern(rows, true), rows);
});

test('applyFinazRule: substitui a coluna que bate com id/codigo/finaz na MESMA posicao (nao move pro inicio)', () => {
  // Bug real encontrado em producao (2026-08-13): mover pro inicio do arquivo
  // quebrava clientes cujo discador le o arquivo por posicao de coluna, nao
  // por nome. A ordem final tem que bater com a do arquivo original.
  const rows = [{ Nome: 'Foo', Codigo: 'ABC123', Telefone: '11999999999' }];
  const result = applyFinazRule(rows);

  assert.equal(result[0].CodigoFinaz, 'ABC123');
  assert.equal(result[0].ProspeccaoId, 'ABC123');
  assert.equal('Codigo' in result[0], false);
  assert.deepEqual(Object.keys(result[0]), ['Nome', 'CodigoFinaz', 'ProspeccaoId', 'Telefone']);
});

test('applyFinazRule: sem coluna id/codigo/finaz, usa a primeira coluna como fallback', () => {
  const rows = [{ Nome: 'Foo', Telefone: '11999999999' }];
  const result = applyFinazRule(rows);

  assert.equal(result[0].CodigoFinaz, 'Foo');
  assert.equal(result[0].ProspeccaoId, 'Foo');
  assert.equal('Nome' in result[0], false);
  assert.deepEqual(Object.keys(result[0]), ['CodigoFinaz', 'ProspeccaoId', 'Telefone']);
});

test('applyFinazRule: array vazio retorna vazio', () => {
  assert.deepEqual(applyFinazRule([]), []);
});

test('Vanguard + FINAZ juntos: CodigoFinaz e ProspeccaoId saem identicos, valor original preservado', () => {
  // Regressao de bug real encontrado em producao (2026-08-12): rodar FINAZ
  // antes do Vanguard faz o Vanguard achar "CodigoFinaz" (contem "codigo" no
  // nome) em vez da coluna original, e so renomear ESSA, deixando
  // CodigoFinaz e ProspeccaoId com nomes/valores divergentes quando
  // deveriam ser identicos.
  const rows = [{ CODIGO: 'TESTE001', nome: 'Fulano', tel: '11988887777' }];
  const afterVanguard = applyVanguardPattern(rows, true);
  assert.deepEqual(Object.keys(afterVanguard[0]), ['codigo', 'nome', 'tel']);

  const result = applyFinazRule(afterVanguard);

  assert.equal(result[0].CodigoFinaz, 'TESTE001');
  assert.equal(result[0].ProspeccaoId, 'TESTE001');
  assert.equal(result[0].CodigoFinaz, result[0].ProspeccaoId);
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

test('applyPhoneOverflowRule: 2o/3o telefone esparso (maioria dos clientes so tem 1) ainda e excluido', () => {
  // Regressao real em producao (2026-08-27), cliente ME7: cabecalho
  // duplicado "ddd;tel;ddd;tel;ddd;tel" (Papa renomeia pra ddd/tel,
  // ddd_1/tel_1, ddd_2/tel_2). A maioria dos clientes so tem o 1o telefone
  // preenchido -- o 2o/3o fica com "0" ou vazio na maior parte das linhas.
  // A checagem por CONTEUDO adicionada como defesa em profundidade (ver
  // pairLooksLikePhone) exigia MAIORIA de linhas validas por coluna, o que
  // e o normal pra telefone excedente esparso -- "DDD 2"/"TEL 2" ficava sem
  // ser excluido, sobrevivendo no arquivo final quando deveria sumir.
  const rows = [
    { CPF: '1', ddd: '34', tel: '984000001', ddd_1: '34', tel_1: '991000001', ddd_2: '31', tel_2: '999000001' },
    { CPF: '2', ddd: '19', tel: '997000001', ddd_1: '0', tel_1: '0', ddd_2: '0', tel_2: '0' },
    { CPF: '3', ddd: '47', tel: '100000001', ddd_1: '47', tel_1: '100000002', ddd_2: '47', tel_2: '985000001' },
    { CPF: '4', ddd: '21', tel: '900000001', ddd_1: '0', tel_1: '0', ddd_2: '0', tel_2: '0' },
  ];
  const result = applyPhoneOverflowRule(rows, 'exclude');
  assert.deepEqual(Object.keys(result[0]), ['CPF', 'ddd', 'tel']);
});

test('applyPhoneOverflowRule: 2o/3o telefone esparso, keep_empty tambem esvazia (nao so exclude)', () => {
  // Mesmo cenario do teste acima, mas pro outro modo configuravel via
  // layout_profile.phone_overflow_action: overflowCols e calculado uma vez
  // so e reaproveitado pelos dois modos, entao o fix de pairLooksLikePhone
  // vale pros dois -- este teste trava o keep_empty especificamente.
  const rows = [
    { CPF: '1', ddd: '34', tel: '984000001', ddd_1: '34', tel_1: '991000001', ddd_2: '31', tel_2: '999000001' },
    { CPF: '2', ddd: '19', tel: '997000001', ddd_1: '0', tel_1: '0', ddd_2: '0', tel_2: '0' },
  ];
  const result = applyPhoneOverflowRule(rows, 'keep_empty');
  assert.deepEqual(Object.keys(result[0]), ['CPF', 'ddd', 'tel', 'ddd_1', 'tel_1', 'ddd_2', 'tel_2']);
  assert.equal(result[0].ddd_1, '');
  assert.equal(result[0].tel_1, '');
  assert.equal(result[0].ddd_2, '');
  assert.equal(result[0].tel_2, '');
  assert.equal(result[0].ddd, '34');
});

test('applyPhoneOverflowRule: um so telefone, nao ha excedente pra tratar', () => {
  const rows = [{ CPF: '1', DDD: '11', Telefone: '999999999' }];
  assert.deepEqual(applyPhoneOverflowRule(rows, 'exclude'), rows);
});

test('applyPhoneOverflowRule: colunas de emprestimo (Valor_Parcela/Parcelas_Paga/Parcelas_Restante) nunca somem, mesmo com action "exclude" (default sem layout_profile)', () => {
  // Regressao end-to-end do bug real em producao (2026-08-25) visto pelo
  // cliente: arquivo higienizado voltava com 3 colunas a menos
  // (Valor_Parcela, Parcelas_Paga, Parcelas_Restante). A causa era
  // detectPhonePairs (usado aqui dentro) casando essas colunas como telefone
  // por substring solta ("par-CEL-a" contem "cel") -- applyPhoneOverflowRule
  // roda com action='exclude' por padrao pra qualquer cliente sem
  // layout_profile configurado, entao a coluna "detectada" como excedente
  // era deletada de toda a base. O fix foi em detectPhonePairs (token, nao
  // substring); este teste garante que a cadeia completa nao regride.
  const rows = [{
    CPF: '11111111111', Nome: 'FULANO', DDD: '17', Telefone: '991110001',
    Contrato: 'CTR001', Prazo: '96', Valor_Parcela: '1331.76', Taxa: '2.03',
    Parcelas_Paga: '11', Parcelas_Restante: '82', UF: 'MG',
  }];
  const result = applyPhoneOverflowRule(rows, 'exclude');
  assert.deepEqual(Object.keys(result[0]), Object.keys(rows[0]));
  assert.equal(result[0].Valor_Parcela, '1331.76');
  assert.equal(result[0].Parcelas_Paga, '11');
  assert.equal(result[0].Parcelas_Restante, '82');
});

test('applyPhoneOverflowRule: coluna cujo NOME bate com telefone mas o VALOR nao (falso positivo de deteccao por nome) nao e excluida', () => {
  // Defesa em profundidade: detectPhonePairs decide so pelo NOME do
  // cabecalho. Se uma coluna tiver nome parecido com telefone por acidente
  // (ex: "Telefone_Ramal" guardando ramal de 4 digitos, nao telefone de
  // verdade), o valor real nao "parece" telefone -- essa checagem extra por
  // conteudo garante que ela fica na base em vez de ser apagada.
  const rows = [
    { CPF: '1', DDD: '11', Telefone: '999999999', Telefone_Ramal: '4521' },
    { CPF: '2', DDD: '21', Telefone: '988888888', Telefone_Ramal: '3010' },
  ];
  const result = applyPhoneOverflowRule(rows, 'exclude');
  assert.equal('Telefone_Ramal' in result[0], true);
  assert.equal(result[0].Telefone_Ramal, '4521');
  assert.equal(result[1].Telefone_Ramal, '3010');
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

test('mergePhoneColumns: layout "junto" (sem coluna DDD separada) mantem a coluna, valor ja limpo nao muda', () => {
  const rows = [{ CPF: '1', Telefone: '11999999999' }];
  assert.deepEqual(mergePhoneColumns(rows), rows);
});

test('mergePhoneColumns: layout "junto" com telefone formatado -- limpa espaco/parenteses/traco mesmo sem coluna DDD separada', () => {
  // Bug real em producao (2026-08-19): cliente mandou telefone formatado
  // numa unica coluna (sem DDD separado) -- por nao ter par DDD, a funcao
  // devolvia a linha sem mexer, e o arquivo final saia com caractere
  // especial no telefone. Nenhuma coluna de telefone pode sair assim,
  // mesmo em layout "junto".
  const rows = [{ nome: 'FULANO', cpf: '123.456.789-00', TEL_1: '(35) 99955-1836' }];
  const result = mergePhoneColumns(rows);
  assert.equal(result[0].TEL_1, '35999551836');
  // Colunas de texto (nome, CPF) nao sao tocadas.
  assert.equal(result[0].nome, 'FULANO');
  assert.equal(result[0].cpf, '123.456.789-00');
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

test('buildFinalFileName: nome do mailing sem extensao (caso comum) ganha .csv no final', () => {
  assert.equal(buildFinalFileName('teste 4 Johnatan', 'AGRESSIVA'), 'teste 4 Johnatan_HIG_AGRESSIVA.csv');
});
