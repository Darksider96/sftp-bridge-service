const { supabaseAdmin } = require('./supabaseAdmin');

// 42P01 (Postgres) / PGRST205 (PostgREST): tabela inexistente.
const TABELA_AUSENTE = ['42P01', 'PGRST205'];
let avisouTabelaAusente = false;

/**
 * Registra um problema na central de alertas (sininho do admin). `chave`
 * identifica o problema: a varredura roda a cada minuto e o mesmo problema
 * não pode virar um alerta novo por minuto. Nunca lança — um alerta não pode
 * derrubar o fluxo de retorno.
 */
async function registrarAlerta(alerta) {
  if (!alerta) return;
  try {
    const { error } = await supabaseAdmin.from('alertas').upsert(
      {
        tipo: alerta.tipo,
        chave: alerta.chave,
        ticket_id: alerta.ticketId ?? null,
        mensagem: alerta.mensagem,
        detalhes: alerta.detalhes ?? null,
      },
      { onConflict: 'chave', ignoreDuplicates: true }
    );
    if (!error) return;

    if (TABELA_AUSENTE.includes(error.code)) {
      // O código pode ser publicado antes de o SQL da central de alertas ser aplicado.
      if (!avisouTabelaAusente) {
        console.warn('alertas: tabela ainda não existe no banco (migration da central de alertas não aplicada) — alertas desativados até lá');
        avisouTabelaAusente = true;
      }
      return;
    }
    console.error(`alertas: falha ao registrar "${alerta.chave}":`, error.message);
  } catch (err) {
    console.error(`alertas: falha ao registrar "${alerta.chave}":`, err.message);
  }
}

module.exports = { registrarAlerta };
