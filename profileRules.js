// Regras fixas por cliente (layout_profile), aplicadas no arquivo final
// pós-PROCV em checkRetorno.js. Nenhuma delas depende do layout do arquivo —
// DDD/Telefone continuam 100% detectados por heurística em csvProcessor.js.
const { detectPhonePairs, extractDddTelefone, headerHasToken } = require('./mailingNormalizer');

// Segunda checagem, por CONTEÚDO, antes de deixar applyPhoneOverflowRule
// apagar uma coluna. detectPhonePairs decide só pelo NOME do cabeçalho —
// bug real em produção (2026-08-25): colunas de parcela de empréstimo
// ("Parcelas_Paga"/"Parcelas_Restante") bateram por acidente com "cel"
// ("par-CEL-a") e a base do cliente voltou com 3 colunas a menos. O nome do
// cabeçalho já foi corrigido (token, não substring), mas essa checagem é
// defesa em profundidade: mesmo que um nome futuro engane a detecção de
// novo, só apaga a coluna se pelo menos ALGUM valor também parecer telefone
// de verdade. Basta 1 linha válida (não maioria) — bug real em produção
// (2026-08-27): 2º/3º telefone é legitimamente esparso (a maioria dos
// clientes só tem 1 telefone preenchido), então exigir maioria válida
// bloqueava a exclusão de colunas de telefone excedente de verdade ("DDD
// 2"/"TEL 2" sobrevivendo no arquivo final quando deveriam ser removidas).
// Só bloqueia a exclusão quando a coluna NUNCA se parece com telefone.
function pairLooksLikePhone(rows, pair) {
  for (const row of rows) {
    const rawTel = row[pair.tel] ?? '';
    const rawDdd = pair.ddd ? row[pair.ddd] ?? '' : '';
    if (extractDddTelefone(rawDdd, rawTel)) return true;
  }
  return false;
}

// "Padrão Vanguard": o discador (Argus/Dazsoft) só reconhece/casa o cliente
// do lado deles se o CABEÇALHO da coluna CODIGO vier em minúsculo — o VALOR
// da coluna não é alterado, só o nome da coluna (ex: "CODIGO" -> "codigo").
// Opt-in por cliente (campo is_vanguard do perfil) — sem o perfil marcado,
// a coluna não é alterada.
function applyVanguardPattern(rows, isVanguard) {
  if (!isVanguard || !rows.length) return rows;
  const codigoKey = Object.keys(rows[0]).find(
    (h) => headerHasToken(h, 'codigo') || headerHasToken(h, 'código')
  );
  if (!codigoKey) return rows;
  const lowerKey = codigoKey.toLowerCase();
  if (lowerKey === codigoKey) return rows;

  return rows.map((row) => {
    const result = {};
    for (const key of Object.keys(row)) {
      result[key === codigoKey ? lowerKey : key] = row[key];
    }
    return result;
  });
}

// Detecta a coluna id/codigo/finaz reaproveitando headerHasToken (mesma
// função usada em detectPhonePairs/detectIdColumn) — bug real em produção
// (2026-08-27): coluna "idade" (idade do cliente, nada a ver com
// identificador) batia com o regex antigo /id|codigo|finaz/i só por conter
// "id" no meio da palavra ("ID-ade"), e a regra FINAZ substituía a coluna de
// IDADE por CodigoFinaz/ProspeccaoId — o dado real de idade do cliente sumia
// do arquivo final (reproduzido nos 4 arquivos de teste, tanto no layout com
// ddd/tel separados quanto no "dddtel" combinado). headerHasToken já exige
// token INTEIRO pra "id" (curto demais — muita palavra real em português
// começa com "id": idade, identidade, idoso...) via EXACT_MATCH_ONLY_KEYWORDS
// em mailingNormalizer.js; reaproveitar em vez de duplicar essa lógica aqui
// garante que os dois lugares nunca saem de sincronia de novo.
function looksLikeFinazIdColumn(header) {
  return (
    headerHasToken(header, 'id') ||
    headerHasToken(header, 'codigo') ||
    headerHasToken(header, 'código') ||
    headerHasToken(header, 'finaz')
  );
}

// Regra FINAZ: substitui a coluna ID/CÓDIGO/FINAZ, na MESMA posição em que
// ela estava, por duas colunas (CodigoFinaz, ProspeccaoId) com o mesmo valor.
// Importante manter a ordem das colunas igual à do arquivo original — o
// discador do cliente pode ler o arquivo por posição, não só por nome de
// coluna (bug real encontrado em produção: mover pro início quebrava isso).
// Configurável por layout_profile (campo is_finaz).
function applyFinazRule(rows) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const idColumn = headers.find(looksLikeFinazIdColumn) || headers[0];
  return rows.map((row) => {
    const idValue = row[idColumn] ?? '';
    const result = {};
    for (const key of Object.keys(row)) {
      if (key === idColumn) {
        result.CodigoFinaz = idValue;
        result.ProspeccaoId = idValue;
      } else {
        result[key] = row[key];
      }
    }
    return result;
  });
}

// RF-003: só o primeiro telefone detectado (o mais à esquerda) é enviado à
// higienização e decide a aprovação da linha — os demais telefones que o
// cliente mandar no arquivo original são "excedentes". Aqui decide o que
// fazer com eles no arquivo final: excluir a coluna ou mantê-la vazia.
// Configurável por layout_profile (campo phone_overflow_action).
function applyPhoneOverflowRule(rows, action) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const pairs = detectPhonePairs(headers, '');
  const overflowCols = new Set();
  pairs.slice(1).forEach((p) => {
    if (!pairLooksLikePhone(rows, p)) return;
    if (p.ddd) overflowCols.add(p.ddd);
    overflowCols.add(p.tel);
  });
  if (!overflowCols.size) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    overflowCols.forEach((col) => {
      if (action === 'exclude') delete copy[col];
      else copy[col] = '';
    });
    return copy;
  });
}

// Funde o DDD e o Telefone (o único par que sobra depois do
// applyPhoneOverflowRule) numa coluna só, só dígitos. Só se aplica no
// arquivo final (download/API) — o arquivo enviado à higienizadora continua
// com CPF;DDD;Telefone separados (mailingNormalizer.js). Se o layout já é
// "junto" (DDD embutido no telefone, sem coluna DDD separada), não há
// coluna pra fundir, mas o VALOR ainda precisa ser limpo — bug real em
// produção (2026-08-19): cliente mandou telefone formatado, ex: "(35)
// 99955-1836", numa coluna só; como não havia DDD separado, a função
// devolvia a linha sem mexer, e o arquivo final saía com espaço/parênteses/
// traço no telefone. Nenhuma coluna de telefone pode sair com caractere
// especial — só dígitos. Colunas de texto (nome, CPF, email etc.) não são
// tocadas aqui.
function mergePhoneColumns(rows) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const pair = detectPhonePairs(headers, '')[0];
  if (!pair) return rows;

  return rows.map((row) => {
    const dddDigits = pair.ddd ? String(row[pair.ddd] ?? '').replace(/\D/g, '') : '';
    const telDigits = String(row[pair.tel] ?? '').replace(/\D/g, '');
    const result = {};
    for (const key of Object.keys(row)) {
      if (pair.ddd && key === pair.ddd) continue;
      result[key] = key === pair.tel ? `${dddDigits}${telDigits}` : row[key];
    }
    return result;
  });
}

// RF-014: sufixo indicando o filtro aplicado, usado tanto no nome salvo para
// download quanto no nome enviado à API do discador (os dois consomem
// tickets.processed_file_name). Base é o nome do Mailing (não o nome do
// arquivo original que o cliente subiu) — geralmente sem extensão, então
// garante ".csv" quando não tiver nenhuma.
function buildFinalFileName(baseName, filterLevel) {
  const suffix = filterLevel === 'MODERADA' ? '_HIG_MODERADA' : '_HIG_AGRESSIVA';
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex === -1
    ? `${baseName}${suffix}.csv`
    : `${baseName.slice(0, dotIndex)}${suffix}${baseName.slice(dotIndex)}`;
}

module.exports = {
  applyVanguardPattern,
  applyFinazRule,
  applyPhoneOverflowRule,
  mergePhoneColumns,
  buildFinalFileName,
};
