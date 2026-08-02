const Papa = require('papaparse');
const { extractTicketId } = require('./ticketIdMatcher');
const { matchTicketByFileName } = require('./fileNameMatcher');
const { processCentrifugeReturn } = require('./csvProcessor');
const { supabaseAdmin } = require('./supabaseAdmin');
const { listDir, download, remove } = require('./sftpClient');

const TICKET_COLUMNS = 'id, client_id, aggressiveness, original_file_url, original_file_name, processed_file_url';

const SFTP_RETORNO_DIR = process.env.SFTP_RETORNO_DIR || '/flag-contato/Retorno';
const BUCKET = 'mailing-files';

let isChecking = false;

/** Dispara uma varredura da pasta Retorno, ignorando se já houver uma em andamento. */
function triggerCheckRetorno() {
  if (isChecking) {
    console.log('check-retorno: já em execução, ignorando novo tick');
    return;
  }
  isChecking = true;
  checkRetorno()
    .catch((err) => console.error('check-retorno: erro fatal na varredura:', err))
    .finally(() => {
      isChecking = false;
    });
}

async function checkRetorno() {
  let files;
  try {
    files = await listDir(SFTP_RETORNO_DIR);
  } catch (err) {
    console.error('check-retorno: falha ao listar a pasta Retorno:', err.message);
    return;
  }

  // Só arquivos no nível raiz — ignora quaisquer subpastas (incl. pastas legado
  // que já existam na SFTP). Este serviço nunca cria pastas dentro de Retorno.
  const candidateFiles = files.filter((f) => f.type === '-');

  for (const file of candidateFiles) {
    try {
      await processReturnedFile(file.name);
    } catch (err) {
      console.error(`check-retorno: erro processando "${file.name}":`, err.message);
      // Não move o arquivo — próximo ciclo tenta de novo (autorrecuperação)
    }
  }
}

async function processReturnedFile(fileName) {
  const remotePath = `${SFTP_RETORNO_DIR}/${fileName}`;
  const ticket = await resolveTicket(fileName);

  if (!ticket) {
    // Não move nem apaga — arquivo fica na raiz de Retorno para revisão manual.
    // Será relogado a cada tick até alguém resolver manualmente.
    console.log(`check-retorno: "${fileName}" não corresponde a nenhum ticket — órfão, mantido em Retorno`);
    return;
  }

  if (ticket.processed_file_url) {
    // Idem: fica em Retorno, sem mover/apagar, para revisão manual.
    console.log(`check-retorno: ticket ${ticket.id} já tem processed_file_url — retorno duplicado, mantido em Retorno`);
    return;
  }

  try {
    const returnedBuffer = await download(remotePath);
    const returnedCsv = returnedBuffer.toString('utf-8');

    const rawUploadPath = `${ticket.client_id}/retorno/${Date.now()}-${ticket.id}.csv`;
    const { error: rawUploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(rawUploadPath, returnedBuffer, { contentType: 'text/csv' });
    if (rawUploadError) throw new Error(`Falha ao subir arquivo bruto de retorno: ${rawUploadError.message}`);

    await supabaseAdmin
      .from('centrifuga_jobs')
      .update({ arquivo_retornado_url: rawUploadPath })
      .eq('ticket_id', ticket.id);

    const { data: originalBlob, error: originalError } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(ticket.original_file_url);
    if (originalError || !originalBlob) {
      throw new Error(`Falha ao baixar arquivo original: ${originalError?.message || 'sem dados'}`);
    }
    const originalCsv = Buffer.from(await originalBlob.arrayBuffer()).toString('utf-8');

    const originalRows = Papa.parse(originalCsv, { header: true, skipEmptyLines: true }).data;
    const returnedRows = Papa.parse(returnedCsv, { header: true, skipEmptyLines: true }).data;

    const filterLevel = ticket.aggressiveness === 'moderada' ? 'MODERADA' : 'AGRESSIVA';
    const finalRows = processCentrifugeReturn(originalRows, returnedRows, filterLevel);
    const finalCsv = Papa.unparse(finalRows);

    const processedUploadPath = `${ticket.client_id}/processed/${Date.now()}-${ticket.id}.csv`;
    const { error: processedUploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(processedUploadPath, Buffer.from(finalCsv, 'utf-8'), { contentType: 'text/csv' });
    if (processedUploadError) throw new Error(`Falha ao subir arquivo processado: ${processedUploadError.message}`);

    // Mesma semântica de "primeiro status com este type" usada em getDefaultStatus() no frontend
    // (src/lib/supabase-data.ts) — pode haver mais de uma linha com type='higienizado'.
    const { data: higienizadoStatus, error: statusError } = await supabaseAdmin
      .from('ticket_statuses')
      .select('id')
      .eq('type', 'higienizado')
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (statusError || !higienizadoStatus) {
      throw new Error(`Status 'higienizado' não encontrado: ${statusError?.message || 'nenhuma linha'}`);
    }

    const { error: ticketUpdateError } = await supabaseAdmin
      .from('tickets')
      .update({
        processed_file_url: processedUploadPath,
        processed_file_name: ticket.original_file_name,
        status_id: higienizadoStatus.id,
      })
      .eq('id', ticket.id);
    if (ticketUpdateError) throw new Error(`Falha ao atualizar ticket: ${ticketUpdateError.message}`);

    await supabaseAdmin
      .from('centrifuga_jobs')
      .update({ status: 'concluido' })
      .eq('ticket_id', ticket.id);

    await remove(remotePath);
    console.log(`check-retorno: ticket ${ticket.id} higienizado com sucesso (${finalRows.length} registros aprovados)`);
  } catch (err) {
    try {
      await supabaseAdmin
        .from('centrifuga_jobs')
        .update({ status: 'falha', erro_mensagem: err.message })
        .eq('ticket_id', ticket.id);
    } catch (updateErr) {
      console.error(`check-retorno: falha ao gravar status de falha do ticket ${ticket.id}:`, updateErr.message);
    }
    throw err;
  }
}

/**
 * Resolve o ticket dono de um arquivo retornado.
 *
 * 1. Tenta o ticket_id embutido no nome (caminho rápido, caso sobreviva ao
 *    processo da higienizadora — hoje não sobrevive na prática, mas é de graça
 *    manter como caminho preferencial). Se houver um id no nome mas ele não
 *    corresponder a nenhum ticket, é órfão — não cai no fallback abaixo.
 * 2. Sem ticket_id no nome (caso comum): casa pelo `original_file_name` entre
 *    os tickets pendentes (sem processed_file_url), pegando o mais antigo em
 *    caso de empate — ver fileNameMatcher.js.
 */
async function resolveTicket(fileName) {
  const embeddedId = extractTicketId(fileName);
  if (embeddedId) {
    const { data: ticket, error } = await supabaseAdmin
      .from('tickets')
      .select(TICKET_COLUMNS)
      .eq('id', embeddedId)
      .maybeSingle();
    if (error) throw new Error(`Erro ao buscar ticket ${embeddedId}: ${error.message}`);
    return ticket;
  }

  const { data: pendingTickets, error: pendingError } = await supabaseAdmin
    .from('tickets')
    .select(TICKET_COLUMNS)
    .is('processed_file_url', null)
    .order('created_at', { ascending: true });
  if (pendingError) throw new Error(`Erro ao buscar tickets pendentes: ${pendingError.message}`);

  return matchTicketByFileName(fileName, pendingTickets || []);
}

module.exports = { triggerCheckRetorno };
