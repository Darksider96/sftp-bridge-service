// Orquestração do fluxo automático de mailings. Banco, rede e webhook chegam
// por parâmetro: é o código que decide enviar para o discador, então precisa
// rodar inteiro nos testes (fluxoAutomatico.test.js) sem tocar em nada real.

const {
  MOTIVOS,
  resolverDestino,
  contarRegistros,
  nomesParaEnvio,
  deveSegurarPorAprovacao,
  envioTravado,
} = require('./fluxoAutomaticoRegras');

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

  // Um ticket com problema não pode parar os outros.
  async function paraCada(tickets, nomeDoPasso, passo) {
    for (const ticket of tickets) {
      try {
        await passo(ticket);
      } catch (err) {
        console.error(`fluxo-automatico: erro no passo "${nomeDoPasso}" do ticket ${ticket.id}:`, err.message);
      }
    }
  }

  async function iniciar() {
    await paraCada(await db.ticketsPorStatus('pendente'), 'iniciar', async (ticket) => {
      const perfil = await db.perfil(ticket.client_id);

      if (perfil?.optante_higienizacao === false) {
        if (await db.reservar(ticket.id, 'pendente', 'enviando')) await enviarAoDestino(ticket, perfil, false);
        return;
      }

      if (!(await db.reservar(ticket.id, 'pendente', 'higienizando'))) return;
      try {
        // Mesma sequência do botão do admin: o processador espera um job 'pendente'.
        await db.criarJobPendente(ticket.id);
        const resposta = await chamarFuncao('processador-centrifuga', { ticketId: ticket.id });
        if (!resposta.data?.success) throw new Error(resposta.data?.error || `HTTP ${resposta.status}`);
      } catch (err) {
        await falhar(ticket, perfil, err.message);
      }
    });
  }

  async function enviar() {
    await paraCada(await db.ticketsPorStatus('higienizando'), 'enviar', async (ticket) => {
      if (!ticket.processed_file_url) return;
      // O arquivo é gravado no ticket antes de o job fechar com o aviso de
      // aprovação; só o job 'concluido' diz se o retorno pode ser enviado.
      const job = await db.ultimoJob(ticket.id);
      if (job?.status !== 'concluido') return;

      const perfil = await db.perfil(ticket.client_id);
      if (deveSegurarPorAprovacao(job)) {
        if (await db.reservar(ticket.id, 'higienizando', 'pausado', { auto_motivo: MOTIVOS.APROVACAO_BAIXA })) {
          await evento('envio_automatico_pausado', ticket, perfil, { motivo: MOTIVOS.APROVACAO_BAIXA });
        }
        return;
      }

      if (await db.reservar(ticket.id, 'higienizando', 'enviando')) await enviarAoDestino(ticket, perfil, true);
    });
  }

  async function recuperar() {
    await paraCada(await db.ticketsPorStatus('enviando'), 'recuperar', async (ticket) => {
      if (!envioTravado(ticket.auto_atualizado_em, agora())) return;
      const motivo = `${MOTIVOS.FALHA}: envio interrompido — confirme no destino antes de reenviar`;
      if (await db.reservar(ticket.id, 'enviando', 'falha', { auto_motivo: motivo })) {
        await evento('envio_automatico_falhou', ticket, await db.perfil(ticket.client_id), { motivo });
      }
    });
  }

  async function avancar() {
    // 'recuperar' primeiro: nunca trata como travado um envio que esta mesma
    // varredura acabou de iniciar.
    await recuperar();
    await iniciar();
    await enviar();
  }

  return { avancar, enviarAoDestino };
}

module.exports = { criarFluxoAutomatico };
