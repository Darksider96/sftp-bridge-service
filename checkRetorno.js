const Papa = require('papaparse');
const { extractTicketId } = require('./ticketIdMatcher');
const { processCentrifugeReturn } = require('./csvProcessor');
const { supabaseAdmin } = require('./supabaseAdmin');
const { listDir, download, moveTo } = require('./sftpClient');

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

  // Só arquivos no nível raiz — ignora subpastas (Processados/Orfaos/Duplicados)
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
  const ticketId = extractTicketId(fileName);

  if (!ticketId) {
    console.log(`check-retorno: "${fileName}" sem ticket_id reconhecível no nome — órfão`);
    await moveTo(remotePath, `${SFTP_RETORNO_DIR}/Orfaos`);
    return;
  }

  const { data: ticket, error: ticketError } = await supabaseAdmin
    .from('tickets')
    .select('id, client_id, aggressiveness, original_file_url, original_file_name, processed_file_url')
    .eq('id', ticketId)
    .maybeSingle();

  if (ticketError) throw new Error(`Erro ao buscar ticket ${ticketId}: ${ticketError.message}`);

  if (!ticket) {
    console.log(`check-retorno: "${fileName}" referencia ticket ${ticketId}, que não existe — órfão`);
    await moveTo(remotePath, `${SFTP_RETORNO_DIR}/Orfaos`);
    return;
  }

  if (ticket.processed_file_url) {
    console.log(`check-retorno: ticket ${ticketId} já tem processed_file_url — retorno duplicado`);
    await moveTo(remotePath, `${SFTP_RETORNO_DIR}/Duplicados`);
    return;
  }

  const returnedBuffer = await download(remotePath);
  const returnedCsv = returnedBuffer.toString('utf-8');

  const rawUploadPath = `${ticket.client_id}/retorno/${Date.now()}-${ticketId}.csv`;
  const { error: rawUploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(rawUploadPath, returnedBuffer, { contentType: 'text/csv' });
  if (rawUploadError) throw new Error(`Falha ao subir arquivo bruto de retorno: ${rawUploadError.message}`);

  await supabaseAdmin
    .from('centrifuga_jobs')
    .update({ arquivo_retornado_url: rawUploadPath, status: 'concluido' })
    .eq('ticket_id', ticketId);

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

  const processedUploadPath = `${ticket.client_id}/processed/${Date.now()}-${ticketId}.csv`;
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
    .eq('id', ticketId);
  if (ticketUpdateError) throw new Error(`Falha ao atualizar ticket: ${ticketUpdateError.message}`);

  await moveTo(remotePath, `${SFTP_RETORNO_DIR}/Processados`);
  console.log(`check-retorno: ticket ${ticketId} higienizado com sucesso (${finalRows.length} registros aprovados)`);
}

module.exports = { triggerCheckRetorno };
