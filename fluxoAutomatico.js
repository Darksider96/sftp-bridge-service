// Orquestração do fluxo automático de mailings. Banco, rede e webhook chegam
// por parâmetro: é o código que decide enviar para o discador, então precisa
// rodar inteiro nos testes (fluxoAutomatico.test.js) sem tocar em nada real.

const { MOTIVOS, resolverDestino, contarRegistros, nomesParaEnvio } = require('./fluxoAutomaticoRegras');

const FUNCAO_DE_UPLOAD = {
  synq: 'higienizadora-upload-synq',
  dazsoft: 'higienizadora-upload-dazsoft',
};

function criarFluxoAutomatico({ db, chamarFuncao, notificar, agora = () => new Date() }) {
  async function evento(event, ticket, perfil, extra = {}) {
    await notificar({
      event,
      ticketId: ticket.id,
      clientId: ticket.client_id,
      clientName: perfil?.name ?? null,
      mailingName: ticket.mailing_name,
      integracao: null,
      registros: null,
      motivo: null,
      ...extra,
    });
  }

  async function pausar(ticket, perfil, motivo) {
    await db.marcar(ticket.id, { auto_status: 'pausado', auto_motivo: motivo });
    await evento('envio_automatico_pausado', ticket, perfil, { motivo });
  }

  // Sem nova tentativa: o destino pode ter recebido o arquivo mesmo
  // respondendo erro, e reenviar importaria o mailing em dobro.
  async function falhar(ticket, perfil, detalhe, integracao = null) {
    const motivo = `${MOTIVOS.FALHA}: ${detalhe}`;
    await db.marcar(ticket.id, { auto_status: 'falha', auto_motivo: motivo });
    await evento('envio_automatico_falhou', ticket, perfil, { motivo, integracao });
  }

  /** O ticket já precisa estar reservado em 'enviando'. */
  async function enviarAoDestino(ticket, perfil, usarProcessado) {
    const integracao = perfil?.auto_integracao_id ? await db.integracao(perfil.auto_integracao_id) : null;
    const destino = perfil ? resolverDestino(perfil, integracao) : { ok: false };
    if (!destino.ok) return pausar(ticket, perfil, MOTIVOS.DESTINO);

    try {
      let { fileName, mailingName } = nomesParaEnvio(ticket, usarProcessado);
      let fileUrl = usarProcessado ? ticket.processed_file_url : ticket.original_file_url;

      if (!usarProcessado) {
        const cabecalho = await chamarFuncao('higienizadora-ensure-mailing-header', { fileUrl, fileName });
        if (!cabecalho.data?.success) {
          throw new Error(cabecalho.data?.error || 'não foi possível preparar o arquivo original');
        }
        fileUrl = cabecalho.data.fileUrl;
        fileName = cabecalho.data.fileName;
      }

      const registros = contarRegistros(await db.baixarArquivo(fileUrl));
      if (registros === 0) return pausar(ticket, perfil, MOTIVOS.SEM_REGISTROS);

      const corpo = { ticketId: ticket.id, clientId: ticket.client_id, fileUrl, fileName, mailing_name: mailingName };
      if (destino.tipo === 'dazsoft') corpo.campanha_id = destino.campanhaId;

      const resposta = await chamarFuncao(FUNCAO_DE_UPLOAD[destino.tipo], corpo);
      if (!resposta.data?.success) {
        throw new Error(resposta.data?.message || `HTTP ${resposta.status}`);
      }

      const campos = {
        auto_status: 'enviado',
        auto_motivo: null,
        auto_integracao: destino.tipo,
        auto_enviado_em: agora().toISOString(),
      };
      const statusFinalId = await db.statusFinalId();
      if (statusFinalId) campos.status_id = statusFinalId;
      await db.marcar(ticket.id, campos);
      await evento('envio_automatico_concluido', ticket, perfil, { integracao: destino.tipo, registros });
    } catch (err) {
      await falhar(ticket, perfil, err.message, destino.tipo);
    }
  }

  return { enviarAoDestino };
}

module.exports = { criarFluxoAutomatico };
