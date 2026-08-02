const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Extrai o primeiro UUID encontrado no nome do arquivo (o ticket_id embutido
 * pelo fluxo de envio). Retorna null se nenhum UUID for encontrado.
 * @param {string} filename
 * @returns {string | null}
 */
function extractTicketId(filename) {
  const match = filename.match(UUID_RE);
  return match ? match[0].toLowerCase() : null;
}

module.exports = { extractTicketId };
