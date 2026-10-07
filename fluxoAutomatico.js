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
  podeRepetirEnvio,
  MAX_TENTATIVAS_ENVIO,
  INTERVALO_TENTATIVAS_MS,
  mailingsParaTicket,
  nomeTicketDoMailing,
} = require('./fluxoAutomaticoRegras');

// Só olha mailings recentes do CRM: limita o custo da varredura sem perder
// nada que tenha chegado durante uma queda do serviço.
const JANELA_CRM_MS = 7 * 24 * 60 * 60 * 1000;

const FUNCAO_DE_UPLOAD = {
  synq: 'higienizadora-upload-synq',
  dazsoft: 'higienizadora-upload-dazsoft',
};

const CONFIRME_NO_DESTINO = 'confirme no destino antes de reenviar';
const aguardar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function criarFluxoAutomatico({ db, chamarFuncao, notificar, agora = () => new Date(), esperar = aguardar }) {
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

  async function falhar(ticket, perfil, detalhe, integracao = null) {
    const motivo = `${MOTIVOS.FALHA}: ${detalhe}`;
    await db.marcar(ticket.id, { auto_status: 'falha', auto_motivo: motivo });
    await evento('envio_automatico_falhou', ticket, perfil, { motivo, integracao });
  }

  // Repete só quando o destino respondeu com erro. Sem resposta, o mailing
  // pode ter entrado no discador: para na hora e pede conferência.
  async function enviarComTentativas(funcao, corpo) {
    for (let tentativa = 1; ; tentativa++) {
      let resposta;
      try {
        resposta = await chamarFuncao(funcao, corpo);
      } catch (err) {
        throw new Error(`${err.message} — ${CONFIRME_NO_DESTINO}`);
      }
      if (resposta.data?.success) return;

      const detalhe = resposta.data?.message || `HTTP ${resposta.status}`;
      if (!podeRepetirEnvio(resposta)) throw new Error(`${detalhe} — ${CONFIRME_NO_DESTINO}`);
      if (tentativa === MAX_TENTATIVAS_ENVIO) throw new Error(`${detalhe} (${MAX_TENTATIVAS_ENVIO} tentativas)`);
      await esperar(INTERVALO_TENTATIVAS_MS);
    }
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

      await enviarComTentativas(FUNCAO_DE_UPLOAD[destino.tipo], corpo);

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
      const motivo = `${MOTIVOS.FALHA}: envio interrompido — ${CONFIRME_NO_DESTINO}`;
      if (await db.reservar(ticket.id, 'enviando', 'falha', { auto_motivo: motivo })) {
        await evento('envio_automatico_falhou', ticket, await db.perfil(ticket.client_id), { motivo });
      }
    });
  }

  // Planilha continua na lista de mailings a cada varredura; sem isto o aviso
  // sairia de minuto em minuto. Vale enquanto o processo estiver de pé.
  const planilhasAvisadas = new Set();

  async function criarTicketsDoCrm() {
    const perfis = await db.perfisAutomaticos();
    if (!perfis.length) return;

    const desde = new Date(agora().getTime() - JANELA_CRM_MS).toISOString();
    const mailings = await db.mailingsDesde(desde, perfis.map((p) => p.id));
    const { criar, planilhas } = mailingsParaTicket(mailings, perfis, await db.chavesComTicket(desde));
    const perfilPorId = new Map(perfis.map((p) => [p.id, p]));

    for (const mailing of criar) {
      try {
        // O banco garante um ticket por mailing; conflito = outra varredura criou antes.
        await db.criarTicketDoMailing({
          client_id: mailing.client_id,
          mailing_name: nomeTicketDoMailing(mailing.file_name),
          campaign_name: '',
          aggressiveness: perfilPorId.get(mailing.client_id).optante_higienizacao === false ? null : 'moderada',
          original_file_url: mailing.file_url,
          original_file_name: mailing.file_name,
          origem_mailing_tipo: mailing.tipo,
          origem_mailing_id: mailing.id,
        });
      } catch (err) {
        console.error(`fluxo-automatico: erro criando ticket do mailing ${mailing.tipo}:${mailing.id}:`, err.message);
      }
    }

    for (const mailing of planilhas) {
      const chave = `${mailing.tipo}:${mailing.id}`;
      if (planilhasAvisadas.has(chave)) continue;
      planilhasAvisadas.add(chave);
      await notificar({
        event: 'envio_automatico_pausado',
        ticketId: null,
        clientId: mailing.client_id,
        clientName: perfilPorId.get(mailing.client_id).name ?? null,
        mailingName: nomeTicketDoMailing(mailing.file_name),
        integracao: null,
        registros: null,
        motivo: MOTIVOS.PLANILHA,
      });
    }
  }

  async function avancar() {
    // 'recuperar' primeiro: nunca trata como travado um envio que esta mesma
    // varredura acabou de iniciar.
    await recuperar();
    try {
      await criarTicketsDoCrm();
    } catch (err) {
      console.error('fluxo-automatico: erro criando tickets do CRM:', err.message);
    }
    await iniciar();
    await enviar();
  }

  return { avancar, enviarAoDestino };
}

module.exports = { criarFluxoAutomatico };
