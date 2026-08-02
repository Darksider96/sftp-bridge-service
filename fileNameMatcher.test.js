const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchTicketByFileName } = require('./fileNameMatcher');

test('casa quando o nome retornado termina com o original_file_name de um ticket pendente', () => {
  const pending = [{ id: 'ticket-1', original_file_name: '5,5k.csv' }];
  const match = matchTicketByFileName('1295226-5,5k.csv', pending);
  assert.equal(match.id, 'ticket-1');
});

test('retorna null quando nenhum ticket pendente bate com o nome', () => {
  const pending = [{ id: 'ticket-1', original_file_name: 'outro_mailing.csv' }];
  assert.equal(matchTicketByFileName('1295226-5,5k.csv', pending), null);
});

test('em empate entre dois tickets com o mesmo nome, retorna o mais antigo (primeiro da lista)', () => {
  const pending = [
    { id: 'ticket-antigo', original_file_name: '5,5k.csv' },
    { id: 'ticket-novo', original_file_name: '5,5k.csv' },
  ];
  const match = matchTicketByFileName('1295227-5,5k.csv', pending);
  assert.equal(match.id, 'ticket-antigo');
});

test('é case-insensitive', () => {
  const pending = [{ id: 'ticket-1', original_file_name: '5,5K.CSV' }];
  const match = matchTicketByFileName('1295226-5,5k.csv', pending);
  assert.equal(match.id, 'ticket-1');
});
