const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractTicketId } = require('./ticketIdMatcher');

test('extrai o ticket_id quando o UUID está embutido no nome do arquivo', () => {
  const id = extractTicketId('732a5c85-d2b2-4c0b-b7f5-4137676721f5_retorno.csv');
  assert.equal(id, '732a5c85-d2b2-4c0b-b7f5-4137676721f5');
});

test('retorna null quando não há UUID reconhecível no nome', () => {
  assert.equal(extractTicketId('mailing_sem_id.csv'), null);
});

test('é case-insensitive e normaliza para minúsculas', () => {
  const id = extractTicketId('732A5C85-D2B2-4C0B-B7F5-4137676721F5_retorno.csv');
  assert.equal(id, '732a5c85-d2b2-4c0b-b7f5-4137676721f5');
});
