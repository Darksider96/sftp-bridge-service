const Papa = require('papaparse');
const { extractTicketId } = require('./ticketIdMatcher');
const { matchTicketByFileName } = require('./fileNameMatcher');
const { processCentrifugeReturn } = require('./csvProcessor');
const { parseMailingCsv } = require('./mailingNormalizer');
const {
  applyVanguardPattern,
  applyFinazRule,
  applyPhoneOverflowRule,
  mergePhoneColumns,
  buildFinalFileName,
} = require('./profileRules');
const { supabaseAdmin } = require('./supabaseAdmin');
const { listDir, download, remove } = require('./sftpClient');

const TICKET_COLUMNS = 'id, client_id, aggressiveness, original_file_url, original_file_name, mailing_name, processed_file_url';

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
    await handlePossibleDuplicateReturn(ticket, fileName, remotePath);
    return;
  }

  await runProcv(ticket, fileName, remotePath);
}

/**
 * Roda o PROCV completo pra um ticket a partir de um arquivo de retorno já
 * localizado no SFTP: baixa, cruza com o original, aplica as regras de
 * perfil, sobe o arquivo final e marca o ticket/job como concluído. Extraído
 * de processReturnedFile pra ser reaproveitado também por
 * handlePossibleDuplicateReturn quando um retorno MAIOR chega depois de um
 * ticket já concluído — mesma lógica, não duas cópias pra manter em sincronia.
 */
async function runProcv(ticket, fileName, remotePath) {
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

    // parseMailingCsv (não Papa.parse cru) porque o arquivo original do cliente pode não ter
    // cabeçalho (ex: layout "finaz") — sem essa detecção a primeira linha vira cabeçalho por
    // engano e o PROCV abaixo não acha nenhuma coluna de telefone pra casar.
    const originalRows = parseMailingCsv(originalCsv);
    const returnedRows = Papa.parse(returnedCsv, { header: true, skipEmptyLines: true }).data;

    // Regras fixas do cliente (se tiver perfil vinculado) — DDD/Telefone
    // continuam 100% detectados por heurística em processCentrifugeReturn
    // (RF-003: só o primeiro telefone conta), o perfil só entra depois, nos
    // ajustes que não dependem do layout do arquivo (FINAZ, telefones
    // excedentes, padrão Vanguard).
    const layoutProfile = await resolveClientLayoutProfile(ticket.client_id);

    const filterLevel = ticket.aggressiveness === 'moderada' ? 'MODERADA' : 'AGRESSIVA';
    let finalRows = processCentrifugeReturn(originalRows, returnedRows, filterLevel);
    // Vanguard PRECISA rodar antes do FINAZ: ambos localizam a coluna pelo nome
    // conter "codigo", e o FINAZ cria uma coluna nova chamada CodigoFinaz — se
    // o Vanguard rodasse depois, ele acharia CodigoFinaz em vez da coluna
    // original e deixaria CodigoFinaz/ProspeccaoId com valores diferentes
    // (quando deveriam ser idênticos). Testado em produção em 2026-08-12.
    finalRows = applyVanguardPattern(finalRows, layoutProfile?.is_vanguard || false);
    if (layoutProfile?.is_finaz) finalRows = applyFinazRule(finalRows);
    finalRows = applyPhoneOverflowRule(finalRows, layoutProfile?.phone_overflow_action || 'exclude');
    finalRows = mergePhoneColumns(finalRows);
    // Papa.unparse usa vírgula por padrão — o resto do pipeline (arquivo original
    // do cliente, arquivo padronizado enviado à higienizadora) usa ponto e vírgula,
    // então o arquivo final precisa manter o mesmo delimitador.
    const finalCsv = Papa.unparse(finalRows, { delimiter: ';' });

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
        // Nome do Mailing (não o nome do arquivo original que o cliente subiu) —
        // é o que o cliente reconhece na tela, e o que precisa aparecer no
        // download/envio à API.
        processed_file_name: buildFinalFileName(ticket.mailing_name, filterLevel),
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

// Pura e testável: decide se dois tamanhos de arquivo (bytes) são "o mesmo
// arquivo reenviado" (duplicata segura de ignorar) ou divergem o bastante
// pra merecer revisão manual antes de qualquer decisão automática. Tolerância
// pequena e fixa (não percentual) — quanto mais rígida, menos risco de um
// retorno genuinamente diferente escapar classificado como "duplicata".
function isSameReturnFile(newSizeBytes, storedSizeBytes) {
  if (storedSizeBytes == null) return false;
  return Math.abs(newSizeBytes - storedSizeBytes) <= 64;
}

// Ticket já tem processed_file_url — pode ser retorno duplicado de verdade
// (o mesmo arquivo reenviado pela higienizadora) ou pode ser um retorno
// DIFERENTE que chegou depois do primeiro (ex: a higienizadora manda o
// resultado em lotes pra mailings grandes: um arquivo pequeno primeiro,
// depois o completo). Descartar sempre como "duplicado" sem olhar o
// conteúdo PERDE DADO REAL: bug real em produção (2026-09), ticket de
// 12.232 telefones — o primeiro retorno trouxe só 2.129 resultados e foi
// processado (1.109 aprovados); um segundo arquivo com o retorno completo
// (~11.500 linhas, 6.202 aprovados) chegou depois e foi descartado como
// "duplicado" em TODO ciclo do cron por mais de 24h, sem nenhum alerta — só
// um console.log perdido nos logs do Render. Uma varredura nos arquivos
// parados na pasta Retorno achou outros 6 tickets no mesmo estado, alguns
// com até 14x mais dado no arquivo descartado do que no que foi processado
// — em todos os casos observados, o padrão foi sempre o mesmo (arquivo
// maior chegando depois == resultado mais completo, nunca um problema).
//
// Compara o TAMANHO do novo arquivo com o que já está salvo
// (arquivo_retornado_url do job mais recente do ticket):
// - Tamanho igual (dentro da tolerância) -> duplicata de verdade,
//   comportamento inalterado: ignora e mantém em Retorno.
// - Novo arquivo MAIOR -> reprocessa automaticamente (runProcv), pelo
//   padrão observado em produção. Isso SUBSTITUI o arquivo final do ticket
//   (o cliente pode já ter agido sobre a lista menor) -- decisão consciente
//   pra nunca mais perder dado aprovado pela higienizadora silenciosamente.
// - Novo arquivo MENOR, ou tamanho anterior desconhecido -> não é seguro
//   assumir que é uma versão "melhor"; não reprocessa sozinho. Grava um job
//   NOVO com status='falha', o mesmo status que já aciona o alerta vermelho
//   em CentrifugeControl.tsx (nenhuma mudança de frontend necessária). O
//   arquivo fica intocado em Retorno pra revisão manual (mesmo caminho
//   usado pra corrigir o ticket de 12k: zerar processed_file_url do ticket
//   e deixar o próximo ciclo pegar o arquivo).
async function handlePossibleDuplicateReturn(ticket, fileName, remotePath) {
  let newSizeBytes;
  try {
    const buffer = await download(remotePath);
    newSizeBytes = buffer.length;
  } catch (err) {
    console.error(`check-retorno: falha ao baixar "${fileName}" pra comparar com o retorno já processado do ticket ${ticket.id}:`, err.message);
    return;
  }

  const { data: currentJob } = await supabaseAdmin
    .from('centrifuga_jobs')
    .select('arquivo_retornado_url')
    .eq('ticket_id', ticket.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  let storedSizeBytes = null;
  if (currentJob?.arquivo_retornado_url) {
    const lastSlash = currentJob.arquivo_retornado_url.lastIndexOf('/');
    const dir = currentJob.arquivo_retornado_url.slice(0, lastSlash);
    const objectName = currentJob.arquivo_retornado_url.slice(lastSlash + 1);
    const { data: listing } = await supabaseAdmin.storage.from(BUCKET).list(dir, { search: objectName });
    storedSizeBytes = listing?.[0]?.metadata?.size ?? null;
  }

  if (isSameReturnFile(newSizeBytes, storedSizeBytes)) {
    console.log(`check-retorno: ticket ${ticket.id} já tem processed_file_url — retorno duplicado (mesmo tamanho, ${newSizeBytes} bytes), mantido em Retorno`);
    return;
  }

  if (storedSizeBytes != null && newSizeBytes > storedSizeBytes) {
    console.warn(`check-retorno: ticket ${ticket.id} recebeu um retorno MAIOR que o já processado (novo: ${newSizeBytes} bytes, anterior: ${storedSizeBytes} bytes) — reprocessando automaticamente`);
    await runProcv(ticket, fileName, remotePath);
    return;
  }

  const mensagem = `Retorno adicional recebido em "${fileName}" (${newSizeBytes} bytes) diverge do já processado (${storedSizeBytes ?? 'tamanho desconhecido'} bytes) e não é maior, então não foi reprocessado automaticamente. Arquivo mantido em Retorno — revisar manualmente.`;
  console.warn(`check-retorno: ticket ${ticket.id} — ${mensagem}`);
  try {
    await supabaseAdmin.from('centrifuga_jobs').insert({
      ticket_id: ticket.id,
      status: 'falha',
      erro_mensagem: mensagem,
    });
  } catch (err) {
    console.error(`check-retorno: falha ao gravar alerta de retorno divergente pro ticket ${ticket.id}:`, err.message);
  }
}

/** Busca o layout_profile vinculado ao cliente do ticket, se houver algum. */
async function resolveClientLayoutProfile(clientId) {
  const { data: clientRow, error: clientError } = await supabaseAdmin
    .from('profiles')
    .select('layout_profile_id')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError || !clientRow?.layout_profile_id) return null;

  const { data: profileRow, error: profileError } = await supabaseAdmin
    .from('layout_profiles')
    .select('is_finaz, is_vanguard, phone_overflow_action')
    .eq('id', clientRow.layout_profile_id)
    .maybeSingle();
  if (profileError) return null;

  return profileRow;
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

module.exports = { triggerCheckRetorno, isSameReturnFile };
