/**
 * Casa um arquivo retornado a um ticket pendente pelo nome original.
 *
 * A higienizadora troca o início do nome do arquivo pelo próprio código
 * interno dela (ex: "1295226-5,5k.csv"), mas preserva o `original_file_name`
 * como sufixo — então o ticket_id que embutimos no envio não sobrevive ao
 * retorno na prática (confirmado em produção).
 *
 * @param {string} fileName Nome do arquivo retornado
 * @param {{id: string, original_file_name: string}[]} pendingTickets
 *   Tickets pendentes (sem processed_file_url), já ordenados do mais antigo
 *   para o mais novo — em caso de mais de um ticket com o mesmo
 *   original_file_name, o primeiro da lista (mais antigo) é retornado.
 * @returns {{id: string, original_file_name: string} | null}
 */
function matchTicketByFileName(fileName, pendingTickets) {
  const lowerFileName = fileName.toLowerCase();
  for (const ticket of pendingTickets) {
    if (!ticket.original_file_name) continue;
    if (lowerFileName.endsWith(ticket.original_file_name.toLowerCase())) {
      return ticket;
    }
  }
  return null;
}

module.exports = { matchTicketByFileName };
